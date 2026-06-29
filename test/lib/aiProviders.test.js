// lib/aiProviders.js の単体試験（APIキー設定済みの場合）。
// 各SDKはtest/mocks配下のモジュールでモック化し、実際の通信を発生させずに
// プロバイダー選択・利用可否判定・リトライ・エラー整形のロジックを直接検証する。
jest.mock("@google/generative-ai", () => require("../mocks/genAiMock"));
jest.mock("@anthropic-ai/sdk", () => require("../mocks/anthropicMock"));
jest.mock("openai", () => require("../mocks/openAiMock"));

process.env.GEMINI_API_KEY = "test-api-key";
process.env.ANTHROPIC_API_KEY = "test-claude-key";
process.env.OPENAI_API_KEY = "test-openai-key";

const aiProviders = require("../../lib/aiProviders");

describe("クライアント初期化（キー設定済み）", () => {
  it("genAI/anthropic/openaiが初期化される", () => {
    expect(aiProviders.genAI).not.toBeNull();
    expect(aiProviders.anthropic).not.toBeNull();
    expect(aiProviders.openai).not.toBeNull();
  });

  it("モデル名が定義されている", () => {
    expect(aiProviders.GEMINI_MODEL).toBe("gemini-2.5-flash-lite");
    expect(aiProviders.CLAUDE_MODEL).toBe("claude-haiku-4-5");
    expect(aiProviders.OPENAI_MODEL).toBe("gpt-5-mini");
  });
});

describe("resolveProvider", () => {
  it.each([
    ["claude", "claude"],
    ["openai", "openai"],
    ["gemini", "gemini"],
    [undefined, "gemini"],
    ["unknown", "gemini"],
    ["", "gemini"],
  ])("%s -> %s", (input, expected) => {
    expect(aiProviders.resolveProvider(input)).toBe(expected);
  });
});

describe("isProviderAvailable", () => {
  it.each(["gemini", "claude", "openai"])("%sはキー設定済みなのでtrue", (provider) => {
    expect(aiProviders.isProviderAvailable(provider)).toBe(true);
  });
});

describe("claudeText", () => {
  it("content配列のtextを連結する", () => {
    const message = { content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] };
    expect(aiProviders.claudeText(message)).toBe("ab");
  });

  it("text以外のブロックは空文字として扱う", () => {
    const message = { content: [{ type: "image" }, { type: "text", text: "x" }] };
    expect(aiProviders.claudeText(message)).toBe("x");
  });
});

describe("throwIfTruncated", () => {
  it("falseの場合は何もしない", () => {
    expect(() => aiProviders.throwIfTruncated(false)).not.toThrow();
  });

  it("trueの場合は出力上限エラーを投げる", () => {
    expect(() => aiProviders.throwIfTruncated(true)).toThrow("出力上限に達し");
  });
});

describe("describeProviderError", () => {
  it("通常のエラーはメッセージをそのまま返す", () => {
    expect(aiProviders.describeProviderError(new Error("失敗しました"))).toBe("失敗しました");
  });

  it("insufficient_quotaの場合は請求設定への案内を付け加える", () => {
    const err = new Error("429 quota exceeded");
    err.code = "insufficient_quota";
    expect(aiProviders.describeProviderError(err)).toContain("利用上限に達しています");
  });
});

describe("withRetry", () => {
  it("成功した場合はリトライせず結果を返す", async () => {
    const fn = jest.fn().mockResolvedValue("ok");
    await expect(aiProviders.withRetry(fn, 2, 1)).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("一時的なエラー(503)はリトライ後に成功する", async () => {
    const fn = jest
      .fn()
      .mockRejectedValueOnce(new Error("503 Service Unavailable"))
      .mockResolvedValueOnce("ok");
    await expect(aiProviders.withRetry(fn, 2, 1)).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("永続的なエラー(insufficient_quota)はリトライせず即座に投げる", async () => {
    const err = new Error("429 quota");
    err.code = "insufficient_quota";
    const fn = jest.fn().mockRejectedValue(err);
    await expect(aiProviders.withRetry(fn, 2, 1)).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("リトライ対象外のエラーは即座に投げる", async () => {
    const err = new Error("APIキーが不正です");
    const fn = jest.fn().mockRejectedValue(err);
    await expect(aiProviders.withRetry(fn, 2, 1)).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("最大リトライ回数を超えると最後のエラーを投げる", async () => {
    const err = new Error("503 Service Unavailable");
    const fn = jest.fn().mockRejectedValue(err);
    await expect(aiProviders.withRetry(fn, 2, 1)).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(3); // 初回 + リトライ2回
  });
});
