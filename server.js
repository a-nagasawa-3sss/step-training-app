// ============================================================
// クラウド研修 STEP進行デモ - サーバー本体
//
// 役割：
//   1. 問題(.md)をGemini APIに渡してSTEP教材(JSON)を自動生成する
//   2. 生成した教材（コース）をライブラリとして複数保存・管理する
//   3. 受講生がアップロードしたスクリーンショットをGemini APIで判定する
//   4. 判定結果（チェック済みの判定基準）をコースごとに永続化する
//
// データの保存先（すべてファイルベース、DB不使用）：
//   data/steps.json          組み込みコース"aws-level1-default"の教材本体
//   data/courses/index.json  生成済みコースの一覧（メタ情報のみ）
//   data/courses/<id>.json   生成済みコースの教材本体（1ファイル1コース）
//   data/progress.json       コースごとの判定基準チェック状態（永続化）
// ============================================================

require("dotenv").config();
const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { GoogleGenerativeAI } = require("@google/generative-ai");

const app = express();

// スクリーンショットはディスクに保存せず、メモリ上でGemini APIへの送信にのみ使う
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 }, // 1ファイル最大8MB
});

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
// 無料枠のリクエスト数上限が他モデルより緩い gemini-2.5-flash-lite に統一する
// （コース生成・スクショ判定のどちらもこの1モデルのみを使う。混在させるとAI Studio側の
//   無料枠の消費状況が分かりにくくなるため、あえて環境変数での切り替えは用意しない）
const GEMINI_MODEL = "gemini-2.5-flash-lite";
const genAI = GEMINI_API_KEY ? new GoogleGenerativeAI(GEMINI_API_KEY) : null;

// --- ファイルパスの定義 ---
// STEP_TRAINING_DATA_DIRが設定されている場合はそちらを使う（結合テストで実データを汚さないための切り替え用）
const DATA_DIR = process.env.STEP_TRAINING_DATA_DIR || path.join(__dirname, "data");
const COURSES_DIR = path.join(DATA_DIR, "courses");
const COURSE_INDEX_PATH = path.join(COURSES_DIR, "index.json");
const PROGRESS_PATH = path.join(DATA_DIR, "progress.json");
// 手作業で作成した最初の教材は、生成コースと区別するための特別なID("builtin")として扱う
const DEFAULT_COURSE_ID = "aws-level1-default";
const DEFAULT_COURSE_PATH = path.join(DATA_DIR, "steps.json");

// ============================================================
// コース（教材データ）の読み書き
// ============================================================

/**
 * 生成済みコースの一覧（id/title/sourceFilenameなどのメタ情報）を読み込む。
 * ファイルが無い・壊れている場合は空配列として扱う（初回起動時など）。
 */
function loadCourseIndex() {
  try {
    return JSON.parse(fs.readFileSync(COURSE_INDEX_PATH, "utf-8"));
  } catch {
    return [];
  }
}

function saveCourseIndex(index) {
  fs.writeFileSync(COURSE_INDEX_PATH, JSON.stringify(index, null, 2));
}

/**
 * コースIDから実際の教材JSONファイルのパスを求める。
 * 組み込みコースだけは data/steps.json という別の固定ファイルを指す
 * （生成コースと同じ data/courses/ に置かず、手作業の教材を上書きされないように分離している）。
 */
function courseFilePath(id) {
  return id === DEFAULT_COURSE_ID
    ? DEFAULT_COURSE_PATH
    : path.join(COURSES_DIR, `${id}.json`);
}

/** コースの教材本体（title/subtitle/steps）を読み込む。存在しなければnull。 */
function loadCourse(id) {
  try {
    return JSON.parse(fs.readFileSync(courseFilePath(id), "utf-8"));
  } catch {
    return null;
  }
}

function saveCourse(id, course) {
  fs.writeFileSync(courseFilePath(id), JSON.stringify(course, null, 2));
}

// ============================================================
// 受講生の進捗（判定基準ごとのチェック状態）の読み書き
//
// 保存形式: { [courseId]: { [stepId]: [true, false, ...] } }
// 配列のインデックスは、そのstepのcheckpoint.criteriaの並び順に対応する。
// ============================================================

/**
 * 進捗データを読み込む。
 * 旧バージョン（コース単位の名前空間が無く、{stepId: [...]}のみのフラットな形式）が
 * 残っている場合は、組み込みコース扱いとして自動的に移行し、新形式で書き戻す。
 */
function loadProgress() {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(PROGRESS_PATH, "utf-8"));
  } catch {
    return {};
  }
  // 値がそのまま配列（[true, false, ...]）になっていれば旧フラット形式と判断する
  const isOldFlatFormat = Object.values(raw).some((v) => Array.isArray(v));
  if (isOldFlatFormat) {
    const migrated = { [DEFAULT_COURSE_ID]: raw };
    saveProgress(migrated);
    return migrated;
  }
  return raw;
}

function saveProgress(progress) {
  fs.writeFileSync(PROGRESS_PATH, JSON.stringify(progress, null, 2));
}

// ============================================================
// Gemini API共通処理
// ============================================================

/**
 * Gemini APIを呼び出し、一時的なエラー（503混雑 / 429レート制限）の場合だけ
 * 指数的に待機時間を延ばしながらリトライする。
 * それ以外のエラー（APIキー不正など）は即座に投げる。
 *
 * @param {number} maxRetries  最大リトライ回数（初回呼び出しを含まない）
 * @param {number} baseDelayMs 1回目のリトライ前に待つ時間。2回目以降はこの倍数で増える
 */
async function generateContentWithRetry(model, contents, maxRetries = 2, baseDelayMs = 1000) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await model.generateContent(contents);
    } catch (err) {
      const retryable = /503|429|UNAVAILABLE|RESOURCE_EXHAUSTED/.test(err.message || "");
      if (!retryable || attempt === maxRetries) throw err;
      await new Promise((resolve) => setTimeout(resolve, baseDelayMs * (attempt + 1)));
    }
  }
}

/**
 * Geminiの応答テキストからJSONを取り出す。
 * 「JSONのみを返して」と指示しても ```json ... ``` のコードブロックで
 * 返してくることがあるため、その記号を取り除いてからparseする。
 */
function extractJson(text) {
  const cleaned = text.trim().replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```$/, "").trim();
  return JSON.parse(cleaned);
}

/**
 * Geminiが生成したコースJSONが、アプリが期待するスキーマを満たしているか検証する。
 * 不正なJSONをそのまま保存してフロントエンドを壊さないようにするための最終チェック。
 * 問題があれば理由付きでエラーを投げ、呼び出し元でAPIエラーとしてユーザーに返す。
 */
function validateCourse(course) {
  if (!course || typeof course !== "object") throw new Error("JSONオブジェクトではありません");
  if (typeof course.title !== "string" || !course.title) throw new Error("title が不正です");
  if (typeof course.subtitle !== "string") throw new Error("subtitle が不正です");
  if (!Array.isArray(course.steps) || course.steps.length === 0) throw new Error("steps が空です");
  course.steps.forEach((step, i) => {
    if (typeof step.id !== "number") throw new Error(`steps[${i}].id が不正です`);
    if (typeof step.title !== "string" || !step.title) throw new Error(`steps[${i}].title が不正です`);
    if (typeof step.goalHtml !== "string") throw new Error(`steps[${i}].goalHtml が不正です`);
    if (typeof step.detailHtml !== "string") throw new Error(`steps[${i}].detailHtml が不正です`);
    if (!step.checkpoint || typeof step.checkpoint.instruction !== "string") {
      throw new Error(`steps[${i}].checkpoint.instruction が不正です`);
    }
    if (!Array.isArray(step.checkpoint.criteria) || step.checkpoint.criteria.length === 0) {
      throw new Error(`steps[${i}].checkpoint.criteria が不正です`);
    }
  });
}

/**
 * 問題の.md本文をGemini APIに渡し、STEP単位の教材JSON（title/subtitle/steps[]）を生成する。
 * 生成→JSON抽出→スキーマ検証までをこの関数内で完結させ、
 * 呼び出し元（generate/regenerateの各エンドポイント）はファイル保存だけに専念できるようにしている。
 */
async function generateCourseFromMarkdown(markdown) {
  if (!genAI) throw new Error("GEMINI_API_KEY が設定されていません（.env を確認してください）");

  // Geminiへの指示文（プロンプト）。
  // 「変換ルール」で出力の質を細かく制御している点が肝になる：
  //   - STEP数を固定せず、教材の見出し構成に応じて柔軟に分割させる
  //   - テーブルの転記だけで終わらせず、説明文を伴う「文章問題」らしい構成にする
  //   - ```コードブロックは改変・分割せず、改行を保ったまま1つの<pre><code>に転記させる
  //     （これを守らないと、受講生がコピーした複数行コマンドが1行に連結されてしまい、
  //       ターミナルでの実行エラーにつながる）
  const prompt = [
    "あなたはクラウド研修教材の編集者です。以下のMarkdown形式の研修問題文を読み、",
    "Webアプリで1タスクずつ進められる形式のJSONデータに変換してください。",
    "",
    "# 変換ルール",
    "- 教材中の「タスク」や大見出しの単位を1つのstepとして分割すること。stepの数は教材の構成によって変わってよく、",
    "  6個や決まった数に揃える必要はない。教材が自然に分かれる単位（大見出し）の数だけstepを作ること",
    "- 各stepには、受講生が達成すべきGOAL、具体的な設定値や手順をまとめたdetail、",
    "  そして受講生がAWSコンソールのスクリーンショットを提出した際にAIが客観的に確認できる判定基準(criteria)を含めること",
    "- criteriaは「〜になっている」「〜が作成されている」のように、スクリーンショットを見れば判定できる具体的な文にすること（リソース名や設定値を含める）",
    "- detailHtmlは、設定値のテーブルや手順を機械的に転記するだけにせず、文章問題として読めるようにすること。",
    "  具体的には、テーブルや手順の前に「このタスクでは何を、なぜ行うのか」を説明する導入文（1〜3文程度）を必ず入れ、",
    "  複数の小タスク（1-1, 1-2...）がある場合はそれぞれの前にも一言説明文を添えること。",
    "  設定値の一覧（テーブル）はそのまま転記してよいが、テーブルだけが並ぶ構成にはしないこと",
    "- goalHtmlも単語の箇条書きではなく、何を達成すれば良いかが分かる短い文章（1〜2文、または説明付きの箇条書き）にすること",
    "- detailHtml・goalHtmlは簡単なHTML（ul/ol/li/p/table/code程度）で記述すること",
    "- 教材中の ``` で囲まれたコードブロック（シェルコマンド等）は、1文字も改変・要約・分割せず、元のテキストのまま転記すること。",
    "  複数行のコマンドは1つの<pre><code>...</code></pre>タグで囲み、行ごとに\\nで改行を入れること。",
    "  コマンドを1行ずつ別々の<code>タグに分けたり、改行を取り除いて1行に連結したりしては絶対にいけない",
    "  （受講生がそのままコピーしてターミナルに貼り付けて実行するため、改行が失われると実行エラーになる）",
    "",
    "# 出力形式",
    "次のJSON形式のみを出力してください。説明文やコードブロック記号は付けないこと。",
    JSON.stringify(
      {
        title: "教材全体のタイトル",
        subtitle: "教材のサブタイトル（無ければ空文字）",
        steps: [
          {
            id: 1,
            title: "タスク1: ◯◯の作成",
            goalHtml: "<p>◯◯を作成し、△△ができる状態にすることが今回のゴールです。</p>",
            detailHtml:
              "<h3>タスクの要件</h3><p>まず◯◯を作成します。これは△△のための土台になります。以下の設定で作成してください。</p><table>...</table><p>続いて□□を行います。これは...のために必要です。以下のコマンドを実行してください。</p><pre><code>sudo dnf update -y\nsudo systemctl enable httpd.service\nsudo systemctl start httpd.service</code></pre>",
            checkpoint: {
              instruction: "アップロードしてほしいスクリーンショットの説明",
              criteria: ["判定基準1", "判定基準2"],
            },
          },
        ],
      },
      null,
      2
    ),
    "",
    "# 教材本文",
    markdown,
  ].join("\n");

  const model = genAI.getGenerativeModel({ model: GEMINI_MODEL });
  // コース生成は教材全文という長文入力＋複雑な構造化出力になるため、判定API(/api/judge)より
  // 一時的な503(混雑)に遭遇しやすい。そのため待機時間・リトライ回数を多めに設定している。
  const result = await generateContentWithRetry(model, [prompt], 4, 3000);
  const text = result.response.text();

  let course;
  try {
    course = extractJson(text);
  } catch (err) {
    throw new Error("Geminiの出力をJSONとして解釈できませんでした: " + err.message);
  }
  validateCourse(course);
  return course;
}

// ============================================================
// ミドルウェア
// ============================================================

// 問題.md本文をJSONボディで送るため、上限を緩めに設定（多くの教材は数十KB程度）
app.use(express.json({ limit: "5mb" }));
// public/ 配下（index.html / app.js / style.css）をそのまま配信する
app.use(express.static(path.join(__dirname, "public")));

// ============================================================
// コースAPI
//   一覧取得 / 個別取得 / 新規生成 / 再生成 / 削除
// ============================================================

// ライブラリ画面に表示する一覧（メタ情報のみ、教材本体は含まない）
app.get("/api/courses", (req, res) => {
  res.json(loadCourseIndex());
});

// 指定コースの教材本体（title/subtitle/steps）を返す。STEP画面の初期表示で使う
app.get("/api/courses/:id", (req, res) => {
  const course = loadCourse(req.params.id);
  if (!course) return res.status(404).json({ error: "コースが見つかりません" });
  res.json(course);
});

// 新しい.mdから新規コースを生成して保存する（既存コースには影響しない）
app.post("/api/courses/generate", async (req, res) => {
  const { markdown, filename } = req.body;
  if (typeof markdown !== "string" || !markdown.trim()) {
    return res.status(400).json({ error: "markdown が空です" });
  }

  try {
    const course = await generateCourseFromMarkdown(markdown);
    // コースIDはUUIDで発行する（ファイル名・進捗データのキーとして使う）
    const id = crypto.randomUUID();
    saveCourse(id, course);

    // ライブラリ一覧にメタ情報を追加（教材本体は別ファイルなので一覧には含めない）
    const index = loadCourseIndex();
    index.push({
      id,
      title: course.title,
      subtitle: course.subtitle,
      sourceFilename: filename || "",
      createdAt: new Date().toISOString(),
      builtin: false,
    });
    saveCourseIndex(index);

    res.json({ id, title: course.title, subtitle: course.subtitle, stepCount: course.steps.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "コースの生成に失敗しました: " + err.message });
  }
});

// 既存コースを別の.mdで上書き生成する（組み込みコースは保護のため不可）。
// 教材の内容が変わるため、そのコースの判定済み進捗もリセットする。
app.post("/api/courses/:id/regenerate", async (req, res) => {
  const { id } = req.params;
  const { markdown, filename } = req.body;
  const index = loadCourseIndex();
  const entry = index.find((c) => c.id === id);

  if (!entry) return res.status(404).json({ error: "コースが見つかりません" });
  if (entry.builtin) return res.status(400).json({ error: "組み込みコースは再生成できません" });
  if (typeof markdown !== "string" || !markdown.trim()) {
    return res.status(400).json({ error: "markdown が空です" });
  }

  try {
    const course = await generateCourseFromMarkdown(markdown);
    saveCourse(id, course); // 同じIDのファイルを上書き

    // 一覧のメタ情報も最新化する
    entry.title = course.title;
    entry.subtitle = course.subtitle;
    entry.sourceFilename = filename || entry.sourceFilename;
    entry.updatedAt = new Date().toISOString();
    saveCourseIndex(index);

    // 教材が変わった以上、旧STEP構成に対するチェック済み状態は意味を持たないため空にする
    const progress = loadProgress();
    progress[id] = {};
    saveProgress(progress);

    res.json({ id, title: course.title, subtitle: course.subtitle, stepCount: course.steps.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "コースの再生成に失敗しました: " + err.message });
  }
});

// コースの削除（教材本体ファイル・一覧エントリ・進捗データをまとめて削除する）
app.delete("/api/courses/:id", (req, res) => {
  const { id } = req.params;
  const index = loadCourseIndex();
  const entry = index.find((c) => c.id === id);

  if (!entry) return res.status(404).json({ error: "コースが見つかりません" });
  if (entry.builtin) return res.status(400).json({ error: "組み込みコースは削除できません" });

  saveCourseIndex(index.filter((c) => c.id !== id));
  try {
    fs.unlinkSync(courseFilePath(id));
  } catch {
    // ファイルが既に無い場合は無視（一覧との不整合があっても削除自体は成功させる）
  }
  const progress = loadProgress();
  delete progress[id];
  saveProgress(progress);

  res.json({ ok: true });
});

// ============================================================
// 進捗API
// ============================================================

// 指定コースの進捗（{stepId: [合否の配列]}）を返す。無ければ空オブジェクト
app.get("/api/progress/:courseId", (req, res) => {
  const progress = loadProgress();
  res.json(progress[req.params.courseId] || {});
});

// 1ステップ分の判定基準チェック状態を保存する。
// フロントエンドはAI判定が返るたびに、その時点の最新配列（合格項目はtrueのまま）を送ってくる
app.post("/api/progress", (req, res) => {
  const { courseId, stepId, criteria } = req.body;
  if (typeof courseId !== "string" || !Number.isInteger(stepId) || !Array.isArray(criteria)) {
    return res.status(400).json({ error: "不正なリクエストです" });
  }
  const progress = loadProgress();
  progress[courseId] = progress[courseId] || {};
  progress[courseId][stepId] = criteria;
  saveProgress(progress);
  res.json({ ok: true });
});

// ============================================================
// 判定API
//   アップロードされたスクリーンショットをGeminiに見せ、
//   未合格の判定基準だけを対象に合否判定させる
// ============================================================

app.post("/api/judge", upload.array("screenshots", 6), async (req, res) => {
  const courseId = req.body.courseId;
  const stepId = Number(req.body.stepId);
  const course = loadCourse(courseId);
  const step = course && course.steps.find((s) => s.id === stepId);

  if (!step) {
    return res.status(400).json({ error: "不正な courseId / stepId です" });
  }
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: "スクリーンショットがアップロードされていません" });
  }
  if (!genAI) {
    return res.status(500).json({ error: "GEMINI_API_KEY が設定されていません（.env を確認してください）" });
  }

  // criteriaIndices: フロントエンドがまだチェックの入っていない判定基準のインデックスだけを送ってくる。
  // これにより、一度合格した項目は再判定の対象から外れ、何度もスクショを貼り直さずに
  // 残りの項目だけを順番に判定していける（指定が無い/不正な場合は全項目を対象にする）。
  const allCriteria = step.checkpoint.criteria;
  let targetIndices = allCriteria.map((_, i) => i);
  try {
    const requested = JSON.parse(req.body.criteriaIndices || "[]");
    if (Array.isArray(requested) && requested.length) {
      targetIndices = requested.filter(
        (i) => Number.isInteger(i) && i >= 0 && i < allCriteria.length
      );
    }
  } catch {
    // 指定がない/不正な場合は全項目を対象にする
  }
  if (targetIndices.length === 0) {
    return res.json({ judgement: "OK", reason: "判定対象の項目がありません（すべて判定済みです）。", checks: [] });
  }

  // 判定基準には元のインデックス番号を振っておき、Geminiの出力にも同じindexを
  // 引き継がせることで、レスポンスとフロントエンドの状態（どの項目が何番目か）を正しく対応付ける
  const criteriaText = targetIndices.map((i) => `${i}. ${allCriteria[i]}`).join("\n");
  const prompt = [
    "あなたはAWSクラウド研修の採点担当者です。受講生がアップロードしたAWSマネジメントコンソールのスクリーンショット（複数枚の場合は全体を合わせて1つの提出物として）を見て、",
    "以下の判定基準を1項目ずつ満たしているかどうかを判定してください。",
    "",
    `# タスク: ${step.title}`,
    "",
    "# 判定基準（先頭の数字はインデックス番号、必ずそのまま出力に使うこと）",
    criteriaText,
    "",
    "# 出力形式",
    "次のJSON形式のみで出力してください。説明文やコードブロック記号は付けないこと。",
    "checksには上記の判定基準を1つずつ、indexの値はそのまま引き継いで、全項目分を出力すること。",
    '{"reason": "全体の判定理由を日本語で2〜4文", "checks": [{"index": 0, "item": "判定基準の項目", "passed": true または false}]}',
  ].join("\n");

  try {
    const model = genAI.getGenerativeModel({ model: GEMINI_MODEL });
    // アップロードされた画像はメモリ上のBufferのまま、base64文字列に変換してGeminiへ渡す
    // （ディスクへの保存は行わない）
    const imageParts = req.files.map((file) => ({
      inlineData: {
        mimeType: file.mimetype,
        data: file.buffer.toString("base64"),
      },
    }));
    const result = await generateContentWithRetry(model, [prompt, ...imageParts]);

    const text = result.response.text().trim();
    let parsed;
    try {
      parsed = extractJson(text);
    } catch {
      // JSONとして解釈できない場合でも、原文をreasonとして返し、判定不能(NG扱い)として処理を継続する
      parsed = { reason: text, checks: [] };
    }

    // Geminiが返したchecks配列をindexで引けるようにしておく
    const checksByIndex = new Map();
    if (Array.isArray(parsed.checks)) {
      parsed.checks.forEach((c) => {
        if (Number.isInteger(c.index)) checksByIndex.set(c.index, c);
      });
    }
    // 依頼した項目(targetIndices)を基準にレスポンスを組み立てる。
    // Geminiが一部の項目について回答を返し忘れた場合も、ここでpassed: falseとして補完される
    const checks = targetIndices.map((i) => {
      const found = checksByIndex.get(i);
      return {
        index: i,
        item: allCriteria[i],
        passed: Boolean(found && found.passed),
      };
    });
    const judgement = checks.every((c) => c.passed) ? "OK" : "NG";

    res.json({ judgement, reason: parsed.reason || "", checks });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Gemini API の呼び出しに失敗しました: " + err.message });
  }
});

const PORT = process.env.PORT || 3000;
// テスト時(require経由)はサーバーを起動せず、supertestがappを直接使えるようにする
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`http://localhost:${PORT} で起動しました`);
  });
}

module.exports = app;
