// ============================================================
// クラウド研修 STEP進行デモ - サーバー本体
//
// 役割：
//   1. 問題(.md)をAI API（Gemini/Claude、トップページで選択）に渡してSTEP教材(JSON)を自動生成する
//   2. 生成した教材（コース）をライブラリとして複数保存・管理する
//   3. 受講生がアップロードしたスクリーンショットをAI APIで判定する
//   4. 判定結果（チェック済みの判定基準）をコースごとに永続化する
//
// 実装はlib/配下のコンポーネントに分割している：
//   lib/dataStore.js      コース・進捗データのファイルI/O
//   lib/aiProviders.js    Gemini/Claude/OpenAI共通の下回り処理（クライアント初期化・リトライ等）
//   lib/courseGenerator.js 問題生成（.md → STEP教材JSON）
//   lib/judge.js           AI判定（スクリーンショットの合否判定）
//   lib/jsonExtract.js     AI応答テキストからのJSON抽出
//   lib/progressEvents.js  コース生成の進捗通知（SSE）
// server.jsはルーティングとリクエスト/レスポンスの整形のみを担う。
// ============================================================

require("dotenv").config(); // .envからAPIキー等を環境変数として読み込む（本番ではホスティング側のSecret管理に置き換える想定）
const express = require("express"); // HTTPサーバー・ルーティング本体
const multer = require("multer"); // multipart/form-data（スクリーンショットのアップロード）を受け取るためのミドルウェア
const path = require("path"); // OS差異を吸収したファイルパス組み立て
const fs = require("fs"); // データファイル（JSON）の同期読み書き
const crypto = require("crypto"); // コースIDのUUID発行に使用

const {
  genAI,
  GEMINI_MODEL,
  anthropic,
  CLAUDE_MODEL,
  openai,
  OPENAI_MODEL,
  PROVIDER_ENV_VAR,
  PROVIDER_LABEL,
  PROVIDER_MODEL,
  resolveProvider,
  isProviderAvailable,
  describeProviderError,
} = require("./lib/aiProviders");
const {
  loadCourseIndex,
  saveCourseIndex,
  courseFilePath,
  loadCourse,
  saveCourse,
  loadProgress,
  saveProgress,
} = require("./lib/dataStore");
const { generateCourseFromMarkdown } = require("./lib/courseGenerator");
const { judgeScreenshots } = require("./lib/judge");
const { getOrCreateProgressJob, sendProgress, closeProgress } = require("./lib/progressEvents");

const app = express();

// スクリーンショットはディスクに保存せず、メモリ上でAI APIへの送信にのみ使う
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 }, // 1ファイル最大8MB
});

// ============================================================
// ミドルウェア
// ============================================================

// 問題.md本文をJSONボディで送るため、上限を緩めに設定（多くの教材は数十KB程度）
app.use(express.json({ limit: "5mb" }));
// public/ 配下（index.html / app.js / style.css）をそのまま配信する
// ※外部サービス化する場合、静的ファイル配信はCDN（CloudFront等）に切り出し、
//   このExpressサーバーはAPI（/api/*）専用にする構成がスケールしやすい
app.use(express.static(path.join(__dirname, "public")));

// ============================================================
// コースAPI
//   一覧取得 / 個別取得 / 新規生成 / 再生成 / 削除
// ============================================================

// 各AIプロバイダーのAPIキー設定状況とモデル名を返す。
// トップページのAI選択UIは、availableがfalseのプロバイダーを選択不可にし、
// modelをラベルの横に表示する
app.get("/api/providers", (req, res) => {
  res.json({
    gemini: { available: Boolean(genAI), model: GEMINI_MODEL },
    claude: { available: Boolean(anthropic), model: CLAUDE_MODEL },
    openai: { available: Boolean(openai), model: OPENAI_MODEL },
  });
});

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

// コース生成/再生成の進捗通知チャンネル。フロントエンドはPOSTの直前にこれをEventSourceで
// 開き、"md_loaded"→"ai_generated"→"json_saved"の順でstageイベントを受け取る。
// jobIdはクライアントが発行し、POST側のリクエストボディにも同じ値を含めて紐付ける。
app.get("/api/courses/generate-progress/:jobId", (req, res) => {
  const { jobId } = req.params;
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write(":ok\n\n"); // 接続確立をすぐクライアントに伝えるための空コメント

  const job = getOrCreateProgressJob(jobId);
  // 接続前にPOST側が先に進んでいた場合に備え、これまでの段階を即時リプレイする
  for (const stage of job.history) {
    res.write(`data: ${JSON.stringify({ stage })}\n\n`);
  }
  job.clients.add(res);

  req.on("close", () => {
    job.clients.delete(res);
  });
});

// 新しい.mdから新規コースを生成して保存する（既存コースには影響しない）
// 処理の流れ：①入力検証 → ②AI APIで教材JSONを生成 → ③教材本体を1ファイルとして保存
//           → ④一覧(index.json)にメタ情報を追記 → ⑤生成結果の要約をレスポンス
// ※AI API呼び出し（generateCourseFromMarkdown）は数秒〜数十秒かかるため、
//   このリクエストはExpressの1ワーカーを長時間占有する。利用者が増える場合は
//   ジョブキュー化（リクエストを受けたら即202を返し、生成は非同期ワーカーで行う）が必要になる
app.post("/api/courses/generate", async (req, res) => {
  const { markdown, filename, aiProvider, jobId } = req.body;
  if (typeof markdown !== "string" || !markdown.trim()) {
    return res.status(400).json({ error: "markdown が空です" });
  }
  const provider = resolveProvider(aiProvider);

  try {
    const course = await generateCourseFromMarkdown(markdown, provider, (stage) => sendProgress(jobId, stage));
    // コースIDはUUIDで発行する（ファイル名・進捗データのキーとして使う）
    const id = crypto.randomUUID();
    saveCourse(id, course);

    // ライブラリ一覧にメタ情報を追加（教材本体は別ファイルなので一覧には含めない）
    // ※loadCourseIndex→push→saveCourseIndexの間に他リクエストの書き込みが挟まると
    //   一方の変更が失われる可能性がある（read-modify-writeの競合、ロック未実装）
    const index = loadCourseIndex();
    index.push({
      id,
      title: course.title,
      subtitle: course.subtitle,
      sourceFilename: filename || "",
      createdAt: new Date().toISOString(),
      aiProvider: provider,
      aiModel: PROVIDER_MODEL[provider],
      builtin: false,
    });
    saveCourseIndex(index);
    sendProgress(jobId, "json_saved");

    res.json({ id, title: course.title, subtitle: course.subtitle, stepCount: course.steps.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "コースの生成に失敗しました: " + describeProviderError(err) });
  } finally {
    closeProgress(jobId);
  }
});

// 既存コースを別の.mdで上書き生成する（組み込みコースは保護のため不可）。
// 教材の内容が変わるため、そのコースの判定済み進捗もリセットする。
app.post("/api/courses/:id/regenerate", async (req, res) => {
  const { id } = req.params;
  const { markdown, filename, aiProvider, jobId } = req.body;
  const index = loadCourseIndex();
  const entry = index.find((c) => c.id === id);

  if (!entry) return res.status(404).json({ error: "コースが見つかりません" });
  if (entry.builtin) return res.status(400).json({ error: "組み込みコースは再生成できません" });
  if (typeof markdown !== "string" || !markdown.trim()) {
    return res.status(400).json({ error: "markdown が空です" });
  }
  const provider = resolveProvider(aiProvider);

  try {
    const course = await generateCourseFromMarkdown(markdown, provider, (stage) => sendProgress(jobId, stage));
    saveCourse(id, course); // 同じIDのファイルを上書き

    // 一覧のメタ情報も最新化する
    entry.title = course.title;
    entry.subtitle = course.subtitle;
    entry.sourceFilename = filename || entry.sourceFilename;
    entry.aiProvider = provider;
    entry.aiModel = PROVIDER_MODEL[provider];
    entry.updatedAt = new Date().toISOString();
    saveCourseIndex(index);

    // 教材が変わった以上、旧STEP構成に対するチェック済み状態は意味を持たないため空にする
    const progress = loadProgress();
    progress[id] = {};
    saveProgress(progress);
    sendProgress(jobId, "json_saved");

    res.json({ id, title: course.title, subtitle: course.subtitle, stepCount: course.steps.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "コースの再生成に失敗しました: " + describeProviderError(err) });
  } finally {
    closeProgress(jobId);
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
//   アップロードされたスクリーンショットをAIに見せ、
//   未合格の判定基準だけを対象に合否判定させる
// ============================================================

// 処理の流れ：①コース/ステップの存在確認 → ②judgeScreenshots()でAI判定を実行 → ③結果をレスポンス
// ※画像はBufferのままメモリに保持してAI APIへ渡す。アップロード数・同時アクセスが増えると
//   メモリ使用量が増えるため、スケール時はディスク/オブジェクトストレージ経由への変更や
//   アップロードサイズ制限の見直しを検討する
app.post("/api/judge", upload.array("screenshots", 6), async (req, res) => {
  const courseId = req.body.courseId;
  const stepId = Number(req.body.stepId);
  const provider = resolveProvider(req.body.aiProvider);
  const course = loadCourse(courseId);
  const step = course && course.steps.find((s) => s.id === stepId);

  if (!step) {
    return res.status(400).json({ error: "不正な courseId / stepId です" });
  }
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: "スクリーンショットがアップロードされていません" });
  }
  if (!isProviderAvailable(provider)) {
    return res.status(500).json({ error: `${PROVIDER_ENV_VAR[provider]} が設定されていません（.env を確認してください）` });
  }

  try {
    // criteriaIndices: フロントエンドがまだチェックの入っていない判定基準のインデックスだけを送ってくる。
    // これにより、一度合格した項目は再判定の対象から外れ、何度もスクショを貼り直さずに
    // 残りの項目だけを順番に判定していける（指定が無い/不正な場合は全項目を対象にする）。
    const result = await judgeScreenshots(step, req.files, provider, req.body.criteriaIndices);
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: `${PROVIDER_LABEL[provider]} API の呼び出しに失敗しました: ` + describeProviderError(err) });
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
