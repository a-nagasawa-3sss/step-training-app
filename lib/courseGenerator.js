// ============================================================
// 問題生成（.md → STEP教材JSON）
//
// 問題の.md本文をAI APIに渡し、STEP単位の教材JSON（title/subtitle/steps[]）を
// 生成→JSON抽出→スキーマ検証までをこのコンポーネント内で完結させ、
// 呼び出し元（server.jsのgenerate/regenerateの各エンドポイント）は
// ファイル保存だけに専念できるようにしている。
// ============================================================

const fs = require("fs");
const path = require("path");
const {
  genAI,
  GEMINI_MODEL,
  anthropic,
  CLAUDE_MODEL,
  openai,
  OPENAI_MODEL,
  PROVIDER_ENV_VAR,
  resolveProvider,
  isProviderAvailable,
  withRetry,
  claudeText,
  throwIfTruncated,
} = require("./aiProviders");
const { extractJson } = require("./jsonExtract");
const { DATA_DIR } = require("./dataStore");

// タスク数の多い教材はJSON出力が長くなるため、デフォルトの出力上限では応答が
// 途中で切れてJSONが不完全になることがある。3モデルで上限・タイムアウトを揃えておく。
const COURSE_GENERATION_MAX_TOKENS = 50000;
const COURSE_GENERATION_TIMEOUT_MS = 8 * 60 * 1000;

/**
 * 教材生成用に、選択中のプロバイダーへプロンプトを送ってテキスト応答を取得する。
 * コース生成は長文入力＋複雑な構造化出力になるため、判定より多めにリトライする。
 */
async function getCourseGenerationText(provider, prompt) {
  if (provider === "claude") {
    // Anthropic SDKは「10分を超える可能性がある」と判断する出力量だとstream必須に
    // なる（実測で20000超から発生）ため、create()ではなくstream()を使う。
    const message = await withRetry(
      () =>
        anthropic.messages
          .stream(
            {
              model: CLAUDE_MODEL,
              max_tokens: COURSE_GENERATION_MAX_TOKENS,
              messages: [{ role: "user", content: prompt }],
            },
            { timeout: COURSE_GENERATION_TIMEOUT_MS }
          )
          .finalMessage(),
      4,
      3000
    );
    throwIfTruncated(message.stop_reason === "max_tokens");
    return claudeText(message);
  }
  if (provider === "openai") {
    const completion = await withRetry(
      () =>
        openai.chat.completions.create(
          {
            model: OPENAI_MODEL,
            max_completion_tokens: COURSE_GENERATION_MAX_TOKENS,
            reasoning_effort: "minimal", // コストを抑えるため、推論に余分なトークンを使わせない
            messages: [{ role: "user", content: prompt }],
          },
          { timeout: COURSE_GENERATION_TIMEOUT_MS }
        ),
      4,
      3000
    );
    throwIfTruncated(completion.choices[0].finish_reason === "length");
    return completion.choices[0].message.content || "";
  }
  const model = genAI.getGenerativeModel({
    model: GEMINI_MODEL,
    generationConfig: { maxOutputTokens: COURSE_GENERATION_MAX_TOKENS },
  });
  const result = await withRetry(
    () => model.generateContent([prompt], { timeout: COURSE_GENERATION_TIMEOUT_MS }),
    4,
    3000
  );
  throwIfTruncated(result.response.candidates?.[0]?.finishReason === "MAX_TOKENS");
  return result.response.text();
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

/**
 * 問題の.md本文をAI APIに渡し、STEP単位の教材JSON（title/subtitle/steps[]）を生成する。
 * 生成→JSON抽出→スキーマ検証までをこの関数内で完結させ、
 * 呼び出し元（generate/regenerateの各エンドポイント）はファイル保存だけに専念できるようにしている。
 */
async function generateCourseFromMarkdown(markdown, aiProvider, onProgress = () => {}) {
  const provider = resolveProvider(aiProvider);
  if (!isProviderAvailable(provider)) {
    throw new Error(`${PROVIDER_ENV_VAR[provider]} が設定されていません（.env を確認してください）`);
  }
  onProgress("md_loaded");

  // AIへの指示文（プロンプト）。
  // 「変換ルール」で出力の質を細かく制御している点が肝になる：
  //   - STEP数を固定せず、教材の見出し構成に応じて柔軟に分割させる
  //   - テーブルの転記だけで終わらせず、説明文を伴う「文章問題」らしい構成にする
  //   - ```コードブロックは改変・分割せず、改行を保ったまま1つの<pre><code>に転記させる
  //     （これを守らないと、受講生がコピーした複数行コマンドが1行に連結されてしまい、
  //       ターミナルでの実行エラーにつながる）
  const prompt = [
    "あなたはIT実践研修教材の編集者です。以下のMarkdown形式の研修問題文を、",
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
    "- また、問題文中に注意点やヒントセクションが設けられている場合、これらはタスクの判定基準に含めないこと。",
    "- 禁止ルールとして問題文中の画像やリンクは無視して、テキスト情報だけで教材を構成してください。",
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
  onProgress("ai_generated");
  return course;
}

module.exports = {
  COURSE_GENERATION_MAX_TOKENS,
  COURSE_GENERATION_TIMEOUT_MS,
  validateCourse,
  generateCourseFromMarkdown,
};
