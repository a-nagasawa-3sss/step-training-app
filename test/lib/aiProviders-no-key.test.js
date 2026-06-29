// lib/aiProviders.js の単体試験（APIキー未設定の場合）。
// 環境変数を読んでgenAI/anthropic/openaiを初期化するタイミングが異なるため、
// キー設定済みのテスト(aiProviders.test.js)とモジュールキャッシュを共有しないよう別ファイルに分離している。
jest.mock("@google/generative-ai", () => require("../mocks/genAiMock"));
jest.mock("@anthropic-ai/sdk", () => require("../mocks/anthropicMock"));
jest.mock("openai", () => require("../mocks/openAiMock"));

process.env.GEMINI_API_KEY = "";
process.env.ANTHROPIC_API_KEY = "";
process.env.OPENAI_API_KEY = "";

const aiProviders = require("../../lib/aiProviders");

describe("クライアント初期化（キー未設定）", () => {
  it("genAI/anthropic/openaiはnullになる", () => {
    expect(aiProviders.genAI).toBeNull();
    expect(aiProviders.anthropic).toBeNull();
    expect(aiProviders.openai).toBeNull();
  });
});

describe("isProviderAvailable", () => {
  it.each(["gemini", "claude", "openai"])("%sはキー未設定なのでfalse", (provider) => {
    expect(aiProviders.isProviderAvailable(provider)).toBe(false);
  });
});
