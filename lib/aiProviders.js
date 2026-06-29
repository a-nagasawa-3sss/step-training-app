// ============================================================
// AI API共通処理（Gemini / Claude / OpenAI）
//
// 各SDKクライアントの初期化、プロバイダーの選択・利用可否判定、
// リトライ・エラー整形など、3プロバイダーで共通の下回り処理を担う。
// 「問題生成」「AI判定」それぞれの呼び出しロジックは courseGenerator.js / judge.js に分離している。
// ============================================================

const { GoogleGenerativeAI } = require("@google/generative-ai"); // Gemini用SDK
const Anthropic = require("@anthropic-ai/sdk"); // Claude用SDK
const OpenAI = require("openai"); // OpenAI用SDK

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

module.exports = {
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
  withRetry,
  claudeText,
  describeProviderError,
  throwIfTruncated,
};
