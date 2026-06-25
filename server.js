// ============================================================
// クラウド研修 STEP進行デモ - サーバー本体
//
// 役割：
//   1. 問題(.md)をAI API（Gemini/Claude、トップページで選択）に渡してSTEP教材(JSON)を自動生成する
//   2. 生成した教材（コース）をライブラリとして複数保存・管理する
//   3. 受講生がアップロードしたスクリーンショットをAI APIで判定する
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
const Anthropic = require("@anthropic-ai/sdk");
const OpenAI = require("openai");

const app = express();

// スクリーンショットはディスクに保存せず、メモリ上でAI APIへの送信にのみ使う
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

const CLAUDE_API_KEY = process.env.ANTHROPIC_API_KEY;
// コストを抑えるため、Claude側も最安価格帯のモデルに固定する
const CLAUDE_MODEL = "claude-haiku-4-5";
const anthropic = CLAUDE_API_KEY ? new Anthropic({ apiKey: CLAUDE_API_KEY }) : null;

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
// コストを抑えるため、OpenAI側も最安価格帯のモデルに固定する
const OPENAI_MODEL = "gpt-5-mini";
// OpenAI SDKは既定でステータス429/5xxを自動で最大2回リトライする。
// このアプリ側のwithRetry()と二重にリトライが掛かり、insufficient_quotaのような
// リトライしても解決しないエラーで無駄に時間がかかるため、SDK側の自動リトライは無効化する
const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY, maxRetries: 0 }) : null;

// 利用可能なAIプロバイダーの定義。フロントエンドはトップページで選んだ値を
// aiProvider としてリクエストに含めてくる（未指定・不正な値はgeminiにフォールバックする）
const PROVIDER_ENV_VAR = { gemini: "GEMINI_API_KEY", claude: "ANTHROPIC_API_KEY", openai: "OPENAI_API_KEY" };
const PROVIDER_LABEL = { gemini: "Gemini", claude: "Claude", openai: "OpenAI" };
const PROVIDER_MODEL = { gemini: GEMINI_MODEL, claude: CLAUDE_MODEL, openai: OPENAI_MODEL };

function resolveProvider(value) {
  return value === "claude" || value === "openai" ? value : "gemini";
}

function isProviderAvailable(provider) {
  if (provider === "claude") return Boolean(anthropic);
  if (provider === "openai") return Boolean(openai);
  return Boolean(genAI);
}

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
// AI API共通処理（Gemini / Claude / OpenAI）
// ============================================================

/**
 * AI APIを呼び出し、一時的なエラー（503/529混雑 / 429レート制限）の場合だけ
 * 指数的に待機時間を延ばしながらリトライする。
 * それ以外のエラー（APIキー不正・利用上限/未払いによるinsufficient_quotaなど、
 * 待っても解決しないエラー）は即座に投げる。
 *
 * @param {() => Promise<any>} fn 実際のAPI呼び出し（リトライ時は毎回呼び直される）
 * @param {number} maxRetries  最大リトライ回数（初回呼び出しを含まない）
 * @param {number} baseDelayMs 1回目のリトライ前に待つ時間。2回目以降はこの倍数で増える
 */
async function withRetry(fn, maxRetries = 2, baseDelayMs = 1000) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      // OpenAIのinsufficient_quota（利用上限到達/未払い）は429で返ってくるが、
      // 待っても解消しないため、リトライ対象から除外する
      const permanent = /insufficient_quota/i.test(err.code || err.type || "");
      const retryable = !permanent && /500|503|429|529|UNAVAILABLE|RESOURCE_EXHAUSTED|overloaded/i.test(err.message || "");
      if (!retryable || attempt === maxRetries) throw err;
      await new Promise((resolve) => setTimeout(resolve, baseDelayMs * (attempt + 1)));
    }
  }
}

/** Claudeの応答(content配列)からテキスト部分だけを連結して取り出す */
function claudeText(message) {
  return message.content.map((block) => block.text || "").join("");
}

/**
 * APIエラーのメッセージを、画面に表示してわかりやすい文言に補強する。
 * OpenAIのinsufficient_quotaは「利用上限/支払い未設定」が原因であり、APIキーの設定ミスと
 * 見分けづらいため、対処先（請求設定ページ）を明示する。
 */
function describeProviderError(err) {
  if (/insufficient_quota/i.test(err.code || err.type || "")) {
    return (
      err.message +
      "（OpenAIの利用上限に達しています。）"
    );
  }
  return err.message;
}

/** 出力上限に達して応答が途中で切れた場合のエラーを投げる（Claude/OpenAI共通） */
function throwIfTruncated(isTruncated) {
  if (!isTruncated) return;
  throw new Error(
    "AIの応答が出力上限に達し、途中で切れました。教材のタスク数を減らすか、.mdを分割して再度お試しください。"
  );
}

/**
 * 教材生成用に、選択中のプロバイダーへプロンプトを送ってテキスト応答を取得する。
 * コース生成は長文入力＋複雑な構造化出力になるため、判定より多めにリトライする。
 */
async function getCourseGenerationText(provider, prompt) {
  if (provider === "claude") {
    // タスク数の多い教材はJSON出力が長くなるため、デフォルト(8192)では応答が
    // 途中で切れてJSONが不完全になることがある。20000は、Anthropic SDKが
    // 「10分を超える可能性がある」と判断してストリーミングを要求してくる閾値
    // （実測で32000以上）の手前で、かつ十分な余裕を持たせた値。
    const message = await withRetry(
      () =>
        anthropic.messages.create({
          model: CLAUDE_MODEL,
          max_tokens: 20000,
          messages: [{ role: "user", content: prompt }],
        }),
      4,
      3000
    );
    throwIfTruncated(message.stop_reason === "max_tokens");
    return claudeText(message);
  }
  if (provider === "openai") {
    const completion = await withRetry(
      () =>
        openai.chat.completions.create({
          model: OPENAI_MODEL,
          max_completion_tokens: 20000,
          reasoning_effort: "minimal", // コストを抑えるため、推論に余分なトークンを使わせない
          messages: [{ role: "user", content: prompt }],
        }),
      4,
      3000
    );
    throwIfTruncated(completion.choices[0].finish_reason === "length");
    return completion.choices[0].message.content || "";
  }
  const model = genAI.getGenerativeModel({ model: GEMINI_MODEL });
  const result = await withRetry(() => model.generateContent([prompt]), 4, 3000);
  return result.response.text();
}

/** 判定用に、選択中のプロバイダーへプロンプト＋スクリーンショットを送ってテキスト応答を取得する */
async function getJudgeResponseText(provider, prompt, files) {
  if (provider === "claude") {
    const message = await withRetry(() =>
      anthropic.messages.create({
        model: CLAUDE_MODEL,
        max_tokens: 2048,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: prompt },
              ...files.map((file) => ({
                type: "image",
                source: { type: "base64", media_type: file.mimetype, data: file.buffer.toString("base64") },
              })),
            ],
          },
        ],
      })
    );
    return claudeText(message).trim();
  }
  if (provider === "openai") {
    const completion = await withRetry(() =>
      openai.chat.completions.create({
        model: OPENAI_MODEL,
        max_completion_tokens: 2048,
        reasoning_effort: "minimal",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: prompt },
              ...files.map((file) => ({
                type: "image_url",
                image_url: { url: `data:${file.mimetype};base64,${file.buffer.toString("base64")}` },
              })),
            ],
          },
        ],
      })
    );
    return (completion.choices[0].message.content || "").trim();
  }
  const model = genAI.getGenerativeModel({ model: GEMINI_MODEL });
  const imageParts = files.map((file) => ({
    inlineData: { mimeType: file.mimetype, data: file.buffer.toString("base64") },
  }));
  const result = await withRetry(() => model.generateContent([prompt, ...imageParts]));
  return result.response.text().trim();
}

/**
 * JSON文字列リテラル内に生の制御文字（改行・タブ等）が混在していても解釈できるよう、
 * 文字列内だけを対象に \n \t 等へエスケープし直す。
 * コードブロックを含む長文を生成させると、AIが「改行を保持したまま転記して」という
 * 指示を素直に解釈しすぎて、JSON的には本来 \n とすべき箇所に生の改行文字を出力してしまい、
 * JSON.parseが「Bad control character in string literal」で失敗するケースがあるための対策。
 */
function escapeControlCharsInJsonStrings(text) {
  let result = "";
  let inString = false;
  let escapeNext = false;
  for (const ch of text) {
    if (!inString) {
      if (ch === '"') inString = true;
      result += ch;
      continue;
    }
    if (escapeNext) {
      result += ch;
      escapeNext = false;
      continue;
    }
    if (ch === "\\") {
      result += ch;
      escapeNext = true;
      continue;
    }
    if (ch === '"') {
      inString = false;
      result += ch;
      continue;
    }
    const code = ch.codePointAt(0);
    if (code === 0x0a) result += "\\n";
    else if (code === 0x0d) result += "\\r";
    else if (code === 0x09) result += "\\t";
    else if (code < 0x20) result += "\\u" + code.toString(16).padStart(4, "0");
    else result += ch;
  }
  return result;
}

/**
 * AIの応答テキストからJSONを取り出す。
 * 「JSONのみを返して」と指示しても ```json ... ``` のコードブロックで
 * 返してくることがあるため、その記号を取り除いてからparseする。
 */
function extractJson(text) {
  const cleaned = text.trim().replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```$/, "").trim();
  return JSON.parse(escapeControlCharsInJsonStrings(cleaned));
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
 * 問題の.md本文をAI APIに渡し、STEP単位の教材JSON（title/subtitle/steps[]）を生成する。
 * 生成→JSON抽出→スキーマ検証までをこの関数内で完結させ、
 * 呼び出し元（generate/regenerateの各エンドポイント）はファイル保存だけに専念できるようにしている。
 */
async function generateCourseFromMarkdown(markdown, aiProvider) {
  const provider = resolveProvider(aiProvider);
  if (!isProviderAvailable(provider)) {
    throw new Error(`${PROVIDER_ENV_VAR[provider]} が設定されていません（.env を確認してください）`);
  }

  // AIへの指示文（プロンプト）。
  // 「変換ルール」で出力の質を細かく制御している点が肝になる：
  //   - STEP数を固定せず、教材の見出し構成に応じて柔軟に分割させる
  //   - テーブルの転記だけで終わらせず、説明文を伴う「文章問題」らしい構成にする
  //   - ```コードブロックは改変・分割せず、改行を保ったまま1つの<pre><code>に転記させる
  //     （これを守らないと、受講生がコピーした複数行コマンドが1行に連結されてしまい、
  //       ターミナルでの実行エラーにつながる）
  const prompt = [
    "あなたはクラウド研修教材の編集者です。以下のMarkdown形式の研修問題文を、",
    "Webアプリで1タスクずつ進められるJSONデータに変換してください。",
    "",
    "# 変換ルール",
    "- 教材中の「タスク」や大見出しの単位を1つのstepとする。step数は教材の構成に応じて可変でよい",
    "- 各stepにGOAL(goalHtml)・要件(detailHtml)・判定基準(checkpoint.criteria)を含める。",
    "  criteriaは「〜になっている」のように、スクリーンショットで判定できる具体的な文（リソース名・設定値を含む）にする",
    "- goalHtml・detailHtmlは単語の箇条書きやテーブルの転記だけで終わらせず、",
    "  「何を・なぜ行うのか」を説明する文章（導入文）を添えること。テーブル自体はそのまま転記してよい。",
    "  簡単なHTML（p/ul/ol/li/table/pre/code程度）で記述する",
    "- ``` のコードブロック（シェルコマンド等）は1文字も改変・要約・分割せず原文のまま<pre><code>に転記する。",
    "  複数行は1つのタグにまとめ、行間の改行や他の制御文字は必ず\\n・\\t等にエスケープする",
    "  （生の改行文字のまま出力したり1行に連結したりするのは厳禁。出力がJSON.parse()できなくなる上、",
    "  受講生がコピペ実行するコマンドも壊れる）",
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

  const text = await getCourseGenerationText(provider, prompt);
  saveDebugAiResponse(provider, text);

  let course;
  try {
    course = extractJson(text);
  } catch (err) {
    throw new Error("AIの出力をJSONとして解釈できませんでした: " + err.message);
  }
  validateCourse(course);
  return course;
}

/**
 * デバッグ用：コース生成APIの生レスポンスをファイルに保存する（直前の1回分のみ、上書き）。
 * JSON解釈エラーが起きた際に、AIが実際に何を返したかをエディタで直接確認できるようにするための仕組み。
 */
function saveDebugAiResponse(provider, text) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(path.join(DATA_DIR, `debug-last-course-response.${provider}.txt`), text);
  } catch (err) {
    console.error("デバッグ用レスポンスの保存に失敗しました", err);
  }
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

// 新しい.mdから新規コースを生成して保存する（既存コースには影響しない）
app.post("/api/courses/generate", async (req, res) => {
  const { markdown, filename, aiProvider } = req.body;
  if (typeof markdown !== "string" || !markdown.trim()) {
    return res.status(400).json({ error: "markdown が空です" });
  }
  const provider = resolveProvider(aiProvider);

  try {
    const course = await generateCourseFromMarkdown(markdown, provider);
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
      aiProvider: provider,
      aiModel: PROVIDER_MODEL[provider],
      builtin: false,
    });
    saveCourseIndex(index);

    res.json({ id, title: course.title, subtitle: course.subtitle, stepCount: course.steps.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "コースの生成に失敗しました: " + describeProviderError(err) });
  }
});

// 既存コースを別の.mdで上書き生成する（組み込みコースは保護のため不可）。
// 教材の内容が変わるため、そのコースの判定済み進捗もリセットする。
app.post("/api/courses/:id/regenerate", async (req, res) => {
  const { id } = req.params;
  const { markdown, filename, aiProvider } = req.body;
  const index = loadCourseIndex();
  const entry = index.find((c) => c.id === id);

  if (!entry) return res.status(404).json({ error: "コースが見つかりません" });
  if (entry.builtin) return res.status(400).json({ error: "組み込みコースは再生成できません" });
  if (typeof markdown !== "string" || !markdown.trim()) {
    return res.status(400).json({ error: "markdown が空です" });
  }
  const provider = resolveProvider(aiProvider);

  try {
    const course = await generateCourseFromMarkdown(markdown, provider);
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

    res.json({ id, title: course.title, subtitle: course.subtitle, stepCount: course.steps.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "コースの再生成に失敗しました: " + describeProviderError(err) });
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

  // 判定基準には元のインデックス番号を振っておき、AIの出力にも同じindexを
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
    // アップロードされた画像はメモリ上のBufferのまま、base64文字列に変換してAI APIへ渡す
    // （ディスクへの保存は行わない）
    const text = await getJudgeResponseText(provider, prompt, req.files);
    let parsed;
    try {
      parsed = extractJson(text);
    } catch {
      // JSONとして解釈できない場合でも、原文をreasonとして返し、判定不能(NG扱い)として処理を継続する
      parsed = { reason: text, checks: [] };
    }

    // AIが返したchecks配列をindexで引けるようにしておく
    const checksByIndex = new Map();
    if (Array.isArray(parsed.checks)) {
      parsed.checks.forEach((c) => {
        if (Number.isInteger(c.index)) checksByIndex.set(c.index, c);
      });
    }
    // 依頼した項目(targetIndices)を基準にレスポンスを組み立てる。
    // AIが一部の項目について回答を返し忘れた場合も、ここでpassed: falseとして補完される
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
