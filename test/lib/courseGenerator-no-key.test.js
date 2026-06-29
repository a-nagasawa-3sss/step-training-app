// lib/courseGenerator.js の単体試験（APIキー未設定の場合）。
// aiProviders.jsが環境変数を読むタイミングが異なるため、キー設定済みのテストと
// モジュールキャッシュを共有しないよう別ファイルに分離している。
jest.mock("fs", () => require("../mocks/fsMock"));
jest.mock("@google/generative-ai", () => require("../mocks/genAiMock"));
jest.mock("@anthropic-ai/sdk", () => require("../mocks/anthropicMock"));
jest.mock("openai", () => require("../mocks/openAiMock"));

process.env.GEMINI_API_KEY = "";
process.env.ANTHROPIC_API_KEY = "";
process.env.OPENAI_API_KEY = "";

const { generateCourseFromMarkdown } = require("../../lib/courseGenerator");

describe("generateCourseFromMarkdown（キー未設定）", () => {
  it("対応するAPIキーが無い場合は、設定すべき環境変数名を含むエラーを投げる", async () => {
    await expect(generateCourseFromMarkdown("# 問題", "gemini")).rejects.toThrow(
      "GEMINI_API_KEY が設定されていません"
    );
  });

  it("aiProvider=claudeでもキー未設定なら同様にエラーを投げる", async () => {
    await expect(generateCourseFromMarkdown("# 問題", "claude")).rejects.toThrow(
      "ANTHROPIC_API_KEY が設定されていません"
    );
  });
});
