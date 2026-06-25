// ============================================================
// クラウド研修 STEP進行デモ - フロントエンド本体
//
// 画面はSPA的に2つの<main>を出し分けるだけのシンプルな構成：
//   #library-screen … 問題（コース）一覧 ＋ 新規問題読み込みフォーム
//   #course-screen  … 選択したコースのSTEP進行画面（タスクGOAL/要件/チェックポイント）
//
// 状態はすべてこのファイルのトップレベル変数で保持し、フレームワークは使わない。
// サーバー側の永続化（進捗）とはAPI経由でやり取りする。
// ============================================================

let courseData = null; // 現在開いているコースの教材本体（title/subtitle/steps）
let currentCourseId = null; // 現在開いているコースのID（API呼び出し時に使う）
let currentIndex = 0; // 現在表示中のstepのインデックス（courseData.steps内の位置）
let selectedFiles = []; // 判定待ちでアップロード/貼り付けされたスクリーンショット(File[])
let regenerateTargetId = null; // 「再生成」対象として選んだコースのID（nullなら新規生成モード）
let mdText = null; // 選択中の.mdファイルの中身（テキスト）
let mdFilename = null; // 選択中の.mdファイルのファイル名（コース生成時にサーバーへ送る）

const AI_PROVIDER_STORAGE_KEY = "stepTrainingAiProvider";
const AI_PROVIDER_LABEL = { gemini: "Gemini", claude: "Claude", openai: "OpenAI" };
let selectedAiProvider = "gemini"; // トップページで選択中のAIプロバイダー（教材生成・判定の両方で使う）
let providerModels = {}; // /api/providers から取得した { gemini: {available, model}, claude: {...} }

// passedStepIds: 全判定基準が合格済みのstep.idの集合（ナビゲーションの✅表示に使う）
const passedStepIds = new Set();
// criteriaPassed: { [stepId]: [true, false, ...] } 形式で、各stepの判定基準ごとの合否を保持する。
// 配列のインデックスは step.checkpoint.criteria の並び順と対応している。
const criteriaPassed = {};

/** 起動時の初期化：イベントリスナーを一通り登録し、まずライブラリ画面を表示する */
async function init() {
  document.getElementById("md-file-input").addEventListener("change", onMdFileSelected);
  document.getElementById("generate-button").addEventListener("click", onGenerateClick);
  document.getElementById("cancel-regenerate-button").addEventListener("click", cancelRegenerate);
  document.getElementById("back-to-library-button").addEventListener("click", showLibraryScreen);

  document.getElementById("screenshot-input").addEventListener("change", onFileSelected);
  document.getElementById("paste-area").addEventListener("paste", onPaste);
  document.getElementById("judge-button").addEventListener("click", onJudgeClick);
  document.getElementById("prev-button").addEventListener("click", () => goTo(currentIndex - 1));
  document.getElementById("next-button").addEventListener("click", () => goTo(currentIndex + 1));

  await initAiProviderSelector();
  await showLibraryScreen();
}

// ============================================================
// AIプロバイダー選択（トップページ）
// ============================================================

/**
 * サーバーにAPIキーが設定されているプロバイダーを問い合わせ、
 * 未設定のプロバイダーは選択できないようにする。
 * 選択結果はlocalStorageに保存し、教材生成・判定のすべてのリクエストで使い回す。
 */
async function initAiProviderSelector() {
  const radios = Array.from(document.querySelectorAll('input[name="ai-provider"]'));
  let providers = {
    gemini: { available: true, model: "" },
    claude: { available: true, model: "" },
    openai: { available: true, model: "" },
  };
  try {
    const res = await fetch("/api/providers");
    providers = await res.json();
  } catch {
    // 取得に失敗した場合は全プロバイダーを選択可能なままにし、実際のリクエスト時のエラーに委ねる
  }
  providerModels = providers;

  const note = document.getElementById("ai-provider-note");
  const unavailableLabels = [];
  radios.forEach((radio) => {
    const info = providers[radio.value] || {};
    radio.disabled = !info.available;
    if (!info.available) unavailableLabels.push(AI_PROVIDER_LABEL[radio.value]);
    const modelSpan = radio.closest("label").querySelector(".ai-provider-model");
    if (modelSpan && info.model) modelSpan.textContent = `（${info.model}）`;
    radio.addEventListener("change", () => {
      if (radio.checked) selectAiProvider(radio.value);
    });
  });
  note.textContent = unavailableLabels.length
    ? `※ ${unavailableLabels.join("・")} はAPIキーが未設定のため選択できません。`
    : "";

  const saved = localStorage.getItem(AI_PROVIDER_STORAGE_KEY);
  const initial = [saved, "gemini", "claude", "openai"].find((p) => p && providers[p] && providers[p].available);
  if (initial) selectAiProvider(initial);
}

/** AIプロバイダーの選択を確定する（ラジオボタンの見た目・状態・localStorageを同期する） */
function selectAiProvider(provider) {
  selectedAiProvider = provider;
  localStorage.setItem(AI_PROVIDER_STORAGE_KEY, provider);
  document.querySelectorAll('input[name="ai-provider"]').forEach((radio) => {
    radio.checked = radio.value === provider;
  });
  const generateButton = document.getElementById("generate-button");
  if (generateButton) generateButton.textContent = `この問題を生成する（${AI_PROVIDER_LABEL[provider]}）`;
}

// ============================================================
// ライブラリ（問題一覧）画面
// ============================================================

/** コース画面からライブラリ画面に戻る（コースの選択状態をクリアして一覧を再取得） */
async function showLibraryScreen() {
  currentCourseId = null;
  document.getElementById("header-subtitle").textContent = "";
  document.getElementById("course-screen").style.display = "none";
  document.getElementById("library-screen").style.display = "flex";
  await loadCourseList();
}

/** サーバーからコース一覧（メタ情報のみ）を取得して再描画する */
async function loadCourseList() {
  const res = await fetch("/api/courses");
  const list = await res.json();
  renderCourseList(list);
}

/** コース一覧をカード形式でDOMに描画する。組み込みコースは再生成/削除ボタンを出さない */
function renderCourseList(list) {
  const container = document.getElementById("course-list");
  container.innerHTML = "";

  if (list.length === 0) {
    container.innerHTML = "<p>まだ問題が登録されていません。下記から.mdを読み込んでください。</p>";
    return;
  }

  list.forEach((course) => {
    const card = document.createElement("div");
    card.className = "course-card";

    const meta = document.createElement("div");
    meta.className = "meta";
    const infoParts = [];
    if (course.createdAt) infoParts.push(`生成日時：${formatDateTime(course.createdAt)}`);
    if (course.aiModel) infoParts.push(`使用AI：${escapeHtml(course.aiModel)}`);
    meta.innerHTML = `<div class="name">${escapeHtml(course.title)}</div><div class="sub">${escapeHtml(course.subtitle || "")}${course.sourceFilename ? " ／ " + escapeHtml(course.sourceFilename) : ""}</div>${infoParts.length ? `<div class="info">${infoParts.join(" ／ ")}</div>` : ""}`;

    const actions = document.createElement("div");
    actions.className = "actions";

    // 「開始/続行」はどのコースにも常に表示する
    const startBtn = document.createElement("button");
    startBtn.className = "start-button";
    startBtn.textContent = "開始 / 続行する";
    startBtn.addEventListener("click", () => openCourse(course.id));
    actions.appendChild(startBtn);

    // 再生成・削除は生成済みコースのみ（組み込みコースは保護のため不可）
    if (!course.builtin) {
      const regenBtn = document.createElement("button");
      regenBtn.textContent = "この問題を再生成";
      regenBtn.addEventListener("click", () => startRegenerate(course));
      actions.appendChild(regenBtn);

      const delBtn = document.createElement("button");
      delBtn.className = "delete-button";
      delBtn.textContent = "削除";
      delBtn.addEventListener("click", () => deleteCourse(course));
      actions.appendChild(delBtn);
    }

    card.appendChild(meta);
    card.appendChild(actions);
    container.appendChild(card);
  });
}

/**
 * 「この問題を再生成」を押したときの準備処理。
 * 実際のAPI呼び出しは行わず、アップロードフォームを「再生成モード」に切り替えるだけ
 * （対象IDをregenerateTargetIdに保持し、見出し文言を変更する）。
 */
function startRegenerate(course) {
  regenerateTargetId = course.id;
  document.getElementById("upload-heading").textContent = `「${course.title}」を再生成`;
  document.getElementById("upload-target-note").textContent =
    "※ 再生成すると、このコースの判定済みチェック状態はリセットされます。";
  document.getElementById("cancel-regenerate-button").style.display = "inline-block";
}

/** 再生成モードを解除し、通常の「新規読み込み」フォーム表示に戻す */
function cancelRegenerate() {
  regenerateTargetId = null;
  document.getElementById("upload-heading").textContent = "新しい問題(.md)を読み込む";
  document.getElementById("upload-target-note").textContent = "";
  document.getElementById("cancel-regenerate-button").style.display = "none";
}

/** コースの削除。誤操作防止のため確認ダイアログを挟む */
async function deleteCourse(course) {
  if (!window.confirm(`「${course.title}」を削除します。よろしいですか？`)) return;
  await fetch(`/api/courses/${course.id}`, { method: "DELETE" });
  await loadCourseList();
}

/**
 * .mdファイル選択時の処理。
 * ファイルの内容はFileReaderでテキストとして読み込み、mdTextに保持しておく
 * （実際の送信はonGenerateClickで行う。ここでは選択直後に「生成する」ボタンを有効化するだけ）。
 */
function onMdFileSelected(e) {
  const file = e.target.files[0];
  const generateButton = document.getElementById("generate-button");
  if (!file) {
    mdText = null;
    mdFilename = null;
    generateButton.disabled = true;
    return;
  }
  mdFilename = file.name;
  const reader = new FileReader();
  reader.onload = () => {
    mdText = reader.result;
    generateButton.disabled = false;
  };
  reader.readAsText(file, "utf-8");
}

/**
 * 「Geminiでこの問題を生成する」ボタンの処理。
 * regenerateTargetIdが設定されていれば既存コースへの再生成（確認ダイアログ＋進捗リセット）、
 * そうでなければ新規コースの生成として、それぞれ別のエンドポイントを呼び分ける。
 */
async function onGenerateClick() {
  const statusBox = document.getElementById("generate-status");
  if (!mdText) {
    statusBox.className = "ng";
    statusBox.textContent = ".mdファイルを選択してください。";
    return;
  }

  // 再生成は既存の進捗を消してしまうため、誤操作防止の確認を必ず挟む
  if (regenerateTargetId) {
    if (!window.confirm("進捗がリセットされます。再生成してよろしいですか？")) return;
  }

  const generateButton = document.getElementById("generate-button");
  generateButton.disabled = true;
  statusBox.className = "";
  statusBox.textContent = `${AI_PROVIDER_LABEL[selectedAiProvider]}で問題を生成中です。しばらくお待ちください...`;

  const url = regenerateTargetId
    ? `/api/courses/${regenerateTargetId}/regenerate`
    : "/api/courses/generate";

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ markdown: mdText, filename: mdFilename, aiProvider: selectedAiProvider }),
    });
    const data = await res.json();

    if (data.error) {
      statusBox.className = "ng";
      statusBox.textContent = `エラー：${data.error}`;
      return;
    }

    // 生成直後にそのまま開始できるよう、結果メッセージの中に「開始する」ボタンを埋め込む
    statusBox.className = "ok";
    statusBox.innerHTML = `「${escapeHtml(data.title)}」を生成しました（タスク数：${data.stepCount}）。`;

    const startNowBtn = document.createElement("button");
    startNowBtn.textContent = "この問題を開始する";
    startNowBtn.style.marginLeft = "10px";
    startNowBtn.addEventListener("click", () => openCourse(data.id));
    statusBox.appendChild(startNowBtn);

    cancelRegenerate();
    document.getElementById("md-file-input").value = "";
    mdText = null;
    mdFilename = null;
    await loadCourseList();
  } catch (err) {
    statusBox.className = "ng";
    statusBox.textContent = `通信エラー：${err.message}`;
  } finally {
    // 生成済み(or失敗後)はファイル未選択の状態に戻るため、ボタンは無効のままにする
    generateButton.disabled = true;
  }
}

// ============================================================
// コース（STEP進行）画面
// ============================================================

/**
 * 指定したコースを開く。教材本体と保存済み進捗を並行取得し、
 * ローカルの状態（criteriaPassed/passedStepIds）を作り直してからコース画面を表示する。
 * 別のコースを開くたびに前のコースの状態が残らないよう、毎回クリアしている点に注意。
 */
async function openCourse(courseId) {
  const [courseRes, progressRes] = await Promise.all([
    fetch(`/api/courses/${courseId}`),
    fetch(`/api/progress/${courseId}`),
  ]);
  if (!courseRes.ok) {
    window.alert("コースの読み込みに失敗しました。");
    return;
  }
  courseData = await courseRes.json();
  const savedProgress = await progressRes.json();

  currentCourseId = courseId;
  passedStepIds.clear();
  Object.keys(criteriaPassed).forEach((k) => delete criteriaPassed[k]);

  // 保存済み進捗を読み込む。判定基準の数が変わっている（コースが再生成された等）場合は
  // 配列の長さが合わないので無視し、renderStep側で改めて未判定の配列として初期化させる
  courseData.steps.forEach((step) => {
    const saved = savedProgress[step.id];
    if (Array.isArray(saved) && saved.length === step.checkpoint.criteria.length) {
      criteriaPassed[step.id] = saved;
      if (saved.every(Boolean)) passedStepIds.add(step.id);
    }
  });

  document.getElementById("header-subtitle").textContent = `${courseData.title} ${courseData.subtitle ? "／ " + courseData.subtitle : ""}`;
  document.getElementById("library-screen").style.display = "none";
  document.getElementById("course-screen").style.display = "block";

  renderNav();
  renderStep(0);
}

/** 左側のSTEPナビゲーション（ボタン一覧）を作り直す */
function renderNav() {
  const nav = document.getElementById("step-nav");
  nav.innerHTML = "";
  courseData.steps.forEach((step, i) => {
    const btn = document.createElement("button");
    btn.textContent = step.title;
    btn.addEventListener("click", () => goTo(i));
    nav.appendChild(btn);
  });
  updateNavState();
}

/** ナビゲーションボタンの「選択中」「合格済み(✅)」の見た目だけを更新する（再生成はしない） */
function updateNavState() {
  const buttons = document.querySelectorAll("#step-nav button");
  buttons.forEach((btn, i) => {
    btn.classList.toggle("active", i === currentIndex);
    btn.classList.toggle("passed", passedStepIds.has(courseData.steps[i].id));
  });
}

/** 指定インデックスのstepへ移動する（範囲外は無視） */
function goTo(index) {
  if (index < 0 || index >= courseData.steps.length) return;
  renderStep(index);
  window.scrollTo(0, 0);
}

/**
 * 指定インデックスのstepをメインパネルに描画する。
 * GOAL/詳細/チェックポイントの表示を入れ替え、アップロード中のファイルや判定結果表示は
 * stepを切り替えるたびにリセットする（前のタスクの選択ファイルが残らないようにするため）。
 */
function renderStep(index) {
  currentIndex = index;
  const step = courseData.steps[index];

  document.getElementById("step-title").textContent = step.title;
  document.getElementById("step-goal").innerHTML = step.goalHtml;
  document.getElementById("step-detail").innerHTML = step.detailHtml;
  document.getElementById("checkpoint-instruction").textContent = step.checkpoint.instruction;

  // 進捗データが無い、または判定基準の数が変わっている場合は未判定状態の配列で初期化する
  if (
    !criteriaPassed[step.id] ||
    criteriaPassed[step.id].length !== step.checkpoint.criteria.length
  ) {
    criteriaPassed[step.id] = new Array(step.checkpoint.criteria.length).fill(false);
  }
  renderCriteria(step);

  selectedFiles = [];
  document.getElementById("screenshot-input").value = "";
  renderPreview();
  const resultBox = document.getElementById("judge-result");
  resultBox.className = "";
  resultBox.innerHTML = "";

  document.getElementById("prev-button").disabled = index === 0;
  document.getElementById("next-button").disabled = index === courseData.steps.length - 1;

  updateNavState();
}

/**
 * チェックポイントの判定基準一覧を、合否状態を反映したチェックボックスリストとして描画する。
 * チェックボックスはdisabledにしており、ユーザーが手動でチェックを入れることはできない
 * （あくまでAI判定結果の表示用）。
 */
function renderCriteria(step) {
  const passedArr = criteriaPassed[step.id];
  const list = document.getElementById("checkpoint-criteria");
  list.innerHTML = "";
  step.checkpoint.criteria.forEach((c, i) => {
    const li = document.createElement("li");
    const label = document.createElement("label");

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = passedArr[i];
    checkbox.disabled = true;

    label.appendChild(checkbox);
    label.appendChild(document.createTextNode(" " + c));
    li.appendChild(label);
    list.appendChild(li);
  });
}

/** ファイル選択(input[type=file])で追加されたスクリーンショットを取り込む */
function onFileSelected(e) {
  addFiles(Array.from(e.target.files || []));
  document.getElementById("screenshot-input").value = "";
}

/**
 * Ctrl+Vでの貼り付けによるスクリーンショット追加。
 * クリップボードの中身が画像であるものだけを取り出してaddFilesに渡す
 * （テキストなど画像以外が貼り付けられた場合は何もしない）。
 */
function onPaste(e) {
  const items = e.clipboardData ? e.clipboardData.items : [];
  const files = [];
  for (const item of items) {
    if (item.type.startsWith("image/")) {
      files.push(item.getAsFile());
    }
  }
  if (files.length) {
    addFiles(files);
    e.preventDefault();
  }
}

/** 選択済みファイル一覧に追加し、プレビューを再描画する（ファイル選択・貼り付け共通の入口） */
function addFiles(files) {
  selectedFiles = selectedFiles.concat(files);
  renderPreview();
}

/** プレビューのサムネイル右上「×」ボタンから、指定インデックスのファイルだけを取り除く */
function removeFile(index) {
  selectedFiles.splice(index, 1);
  renderPreview();
}

/** 選択中のスクリーンショットをサムネイル一覧として描画する（各サムネイルに削除ボタン付き） */
function renderPreview() {
  const preview = document.getElementById("preview");
  preview.innerHTML = "";
  selectedFiles.forEach((file, index) => {
    const thumb = document.createElement("div");
    thumb.className = "thumb";

    const img = document.createElement("img");
    img.src = URL.createObjectURL(file);
    thumb.appendChild(img);

    const removeBtn = document.createElement("button");
    removeBtn.className = "thumb-remove";
    removeBtn.textContent = "×";
    removeBtn.title = "削除";
    removeBtn.addEventListener("click", () => removeFile(index));
    thumb.appendChild(removeBtn);

    preview.appendChild(thumb);
  });
}

/**
 * 「スクリーンショットをAIに判定してもらう」ボタンの処理。
 *
 * ポイント：
 *   - すでに合格済み(criteriaPassed[step.id][i] === true)の項目はpendingIndicesに含めず、
 *     未合格の項目だけをサーバーへ送る（＝同じ項目を何度も判定し直さない）
 *   - 判定が返ってきたら、合格した項目だけpassedArrを更新し、サーバーにも保存する
 *   - 判定が終わったスクリーンショットは（合否にかかわらず）毎回クリアする。
 *     次の判定では新しいスクショを貼り直してもらう想定のため
 */
async function onJudgeClick() {
  const step = courseData.steps[currentIndex];
  const resultBox = document.getElementById("judge-result");
  const passedArr = criteriaPassed[step.id];
  const pendingIndices = passedArr.reduce((acc, passed, i) => {
    if (!passed) acc.push(i);
    return acc;
  }, []);

  if (pendingIndices.length === 0) {
    resultBox.className = "ok";
    resultBox.innerHTML = "<b>このタスクの判定基準はすべて合格済みです。</b>";
    return;
  }
  if (selectedFiles.length === 0) {
    resultBox.className = "ng";
    resultBox.innerHTML = "<b>スクリーンショットを選択してください。</b>";
    return;
  }

  const button = document.getElementById("judge-button");
  button.disabled = true;
  button.textContent = "AIが判定中...";
  resultBox.className = "";
  resultBox.innerHTML = "";

  const formData = new FormData();
  formData.append("courseId", currentCourseId);
  formData.append("stepId", step.id);
  // 未合格の項目のインデックスだけをサーバーに伝える（サーバー側でこのインデックスだけをAIに判定させる）
  formData.append("criteriaIndices", JSON.stringify(pendingIndices));
  formData.append("aiProvider", selectedAiProvider);
  selectedFiles.forEach((file) => formData.append("screenshots", file));

  try {
    const res = await fetch("/api/judge", { method: "POST", body: formData });
    const data = await res.json();

    if (data.error) {
      resultBox.className = "ng";
      resultBox.innerHTML = `<b>エラー：</b>${escapeHtml(data.error)}`;
      return;
    }

    // 合格した項目だけをtrueにする（falseで返ってきた項目はそのまま、次回また判定対象になる）
    if (Array.isArray(data.checks)) {
      data.checks.forEach((c) => {
        if (c.passed && Number.isInteger(c.index)) {
          passedArr[c.index] = true;
        }
      });
    }
    renderCriteria(step);
    persistProgress(step.id, passedArr); // サーバー側にも保存し、リロード後も状態を保つ

    const allPassed = passedArr.every(Boolean);
    resultBox.className = allPassed ? "ok" : "unknown";

    let html = `<b>今回の判定結果：${allPassed ? "全項目合格" : "一部未合格"}</b><p>${escapeHtml(data.reason || "")}</p>`;
    if (Array.isArray(data.checks) && data.checks.length) {
      html += "<ul class='checks'>";
      data.checks.forEach((c) => {
        html += `<li>${c.passed ? "✅" : "❌"} ${escapeHtml(c.item || "")}</li>`;
      });
      html += "</ul>";
    }
    resultBox.innerHTML = html;

    // 判定が終わったスクリーンショットは毎回クリアする（次回は新しいスクショを貼ってもらう）
    selectedFiles = [];
    document.getElementById("screenshot-input").value = "";
    renderPreview();

    if (allPassed) {
      passedStepIds.add(step.id);
      updateNavState();
    }
  } catch (err) {
    resultBox.className = "ng";
    resultBox.innerHTML = `<b>通信エラー：</b>${escapeHtml(err.message)}`;
  } finally {
    button.disabled = false;
    button.textContent = "スクリーンショットをAIに判定してもらう";
  }
}

/**
 * 1ステップ分の判定基準チェック状態をサーバーに保存する。
 * 失敗してもUIをブロックしない（ローカルの表示はすでに更新済みのため、保存失敗時は
 * 次回リロード時に最新状態が復元されない可能性がある、という程度の影響に留める）。
 */
async function persistProgress(stepId, criteria) {
  try {
    await fetch("/api/progress", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ courseId: currentCourseId, stepId, criteria }),
    });
  } catch (err) {
    console.error("進捗の保存に失敗しました", err);
  }
}

/** ISO日時文字列を一覧表示用の「YYYY/MM/DD HH:MM」形式に変換する */
function formatDateTime(isoString) {
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** ユーザー入力やAPI応答由来の文字列をinnerHTMLに埋め込む際のXSS対策（HTMLエスケープ） */
function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

init();
