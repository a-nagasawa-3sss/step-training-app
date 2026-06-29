// lib/judge.js の単体試験（APIキー設定済みの場合）。
// 各AI SDKはtest/mocks配下のモジュールでモック化し、実際の通信を発生させずに
// スクリーンショット判定ロジック（プロンプト構築・判定対象の絞り込み・合否算出）を直接検証する。
jest.mock("@google/generative-ai", () => require("../mocks/genAiMock"));
jest.mock("@anthropic-ai/sdk", () => require("../mocks/anthropicMock"));
jest.mock("openai", () => require("../mocks/openAiMock"));

const { mockGenerateContent } = require("../mocks/genAiMock");
const { mockMessagesCreate } = require("../mocks/anthropicMock");
const { mockChatCompletionsCreate } = require("../mocks/openAiMock");

process.env.GEMINI_API_KEY = "test-api-key";
process.env.ANTHROPIC_API_KEY = "test-claude-key";
process.env.OPENAI_API_KEY = "test-openai-key";

const { judgeScreenshots } = require("../../lib/judge");

function geminiText(text) {
  return { response: { text: () => text } };
}
function claudeMessage(text, stopReason = "end_turn") {
  return { content: [{ type: "text", text }], stop_reason: stopReason };
}
function openAiCompletion(text, finishReason = "stop") {
  return { choices: [{ message: { content: text }, finish_reason: finishReason }] };
}
function step(overrides = {}) {
  return {
    title: "タスク1",
    checkpoint: { instruction: "スクショ説明", criteria: ["基準1", "基準2"] },
    ...overrides,
  };
}
const files = [{ mimetype: "image/png", buffer: Buffer.from("fake-image") }];

beforeEach(() => {
  mockGenerateContent.mockReset();
  mockMessagesCreate.mockReset();
  mockChatCompletionsCreate.mockReset();
});

describe("judgeScreenshots", () => {
  it("criteriaIndices未指定なら全項目を判定対象にする", async () => {
    mockGenerateContent.mockResolvedValueOnce(
      geminiText(
        JSON.stringify({
          reason: "判定理由",
          checks: [
            { index: 0, item: "基準1", passed: true },
            { index: 1, item: "基準2", passed: false },
          ],
        })
      )
    );

    const result = await judgeScreenshots(step(), files, "gemini", undefined);

    expect(result.judgement).toBe("NG");
    expect(result.checks).toEqual([
      { index: 0, item: "基準1", passed: true },
      { index: 1, item: "基準2", passed: false },
    ]);
  });

  it("criteriaIndicesで指定した項目だけを判定対象にする", async () => {
    mockGenerateContent.mockResolvedValueOnce(
      geminiText(JSON.stringify({ reason: "OK", checks: [{ index: 1, item: "基準2", passed: true }] }))
    );

    const result = await judgeScreenshots(step(), files, "gemini", JSON.stringify([1]));

    expect(result.judgement).toBe("OK");
    expect(result.checks).toEqual([{ index: 1, item: "基準2", passed: true }]);
  });

  it("criteriaIndicesが範囲外の値のみの場合はAIを呼ばずに判定済み扱いとする", async () => {
    const result = await judgeScreenshots(step(), files, "gemini", JSON.stringify([99]));

    expect(result).toEqual({ judgement: "OK", reason: expect.any(String), checks: [] });
    expect(mockGenerateContent).not.toHaveBeenCalled();
  });

  it("criteriaIndicesが不正なJSONの場合は全項目を対象にフォールバックする", async () => {
    mockGenerateContent.mockResolvedValueOnce(
      geminiText(
        JSON.stringify({
          reason: "OK",
          checks: [
            { index: 0, item: "基準1", passed: true },
            { index: 1, item: "基準2", passed: true },
          ],
        })
      )
    );

    const result = await judgeScreenshots(step(), files, "gemini", "not-json");

    expect(result.checks).toHaveLength(2);
  });

  it("AIの応答がJSONでない場合は全項目NGとして処理を継続する", async () => {
    mockGenerateContent.mockResolvedValueOnce(geminiText("判定できませんでした(JSONではない)"));

    const result = await judgeScreenshots(step(), files, "gemini", undefined);

    expect(result.judgement).toBe("NG");
    expect(result.checks.every((c) => c.passed === false)).toBe(true);
    expect(result.reason).toContain("判定できませんでした");
  });

  it("AIが一部の項目について回答を返し忘れた場合はpassed:falseで補完する", async () => {
    mockGenerateContent.mockResolvedValueOnce(
      geminiText(JSON.stringify({ reason: "OK", checks: [{ index: 0, item: "基準1", passed: true }] }))
    );

    const result = await judgeScreenshots(step(), files, "gemini", undefined);

    expect(result.checks).toEqual([
      { index: 0, item: "基準1", passed: true },
      { index: 1, item: "基準2", passed: false },
    ]);
    expect(result.judgement).toBe("NG");
  });

  it("AI呼び出しが失敗(リトライ対象外)した場合はエラーを投げる", async () => {
    mockGenerateContent.mockRejectedValueOnce(new Error("呼び出し失敗"));
    await expect(judgeScreenshots(step(), files, "gemini", undefined)).rejects.toThrow("呼び出し失敗");
  });

  it("一時的な503エラーはリトライ後に成功する", async () => {
    mockGenerateContent
      .mockRejectedValueOnce(new Error("[503 Service Unavailable] busy"))
      .mockResolvedValueOnce(
        geminiText(
          JSON.stringify({
            reason: "OK",
            checks: [
              { index: 0, item: "基準1", passed: true },
              { index: 1, item: "基準2", passed: true },
            ],
          })
        )
      );

    const result = await judgeScreenshots(step(), files, "gemini", undefined);

    expect(result.judgement).toBe("OK");
    expect(mockGenerateContent).toHaveBeenCalledTimes(2);
  });

  it("aiProvider=claudeの場合はClaude APIで判定する", async () => {
    mockMessagesCreate.mockResolvedValueOnce(
      claudeMessage(
        JSON.stringify({
          reason: "OK",
          checks: [
            { index: 0, item: "基準1", passed: true },
            { index: 1, item: "基準2", passed: true },
          ],
        })
      )
    );

    const result = await judgeScreenshots(step(), files, "claude", undefined);

    expect(result.judgement).toBe("OK");
    expect(mockMessagesCreate).toHaveBeenCalledTimes(1);
    expect(mockGenerateContent).not.toHaveBeenCalled();
  });

  it("aiProvider=openaiの場合はOpenAI APIで判定する", async () => {
    mockChatCompletionsCreate.mockResolvedValueOnce(
      openAiCompletion(
        JSON.stringify({
          reason: "OK",
          checks: [
            { index: 0, item: "基準1", passed: true },
            { index: 1, item: "基準2", passed: true },
          ],
        })
      )
    );

    const result = await judgeScreenshots(step(), files, "openai", undefined);

    expect(result.judgement).toBe("OK");
    expect(mockChatCompletionsCreate).toHaveBeenCalledTimes(1);
    expect(mockGenerateContent).not.toHaveBeenCalled();
  });

  it("複数枚のスクリーンショットを送信できる", async () => {
    mockGenerateContent.mockResolvedValueOnce(
      geminiText(
        JSON.stringify({
          reason: "OK",
          checks: [
            { index: 0, item: "基準1", passed: true },
            { index: 1, item: "基準2", passed: true },
          ],
        })
      )
    );
    const multipleFiles = [
      { mimetype: "image/png", buffer: Buffer.from("img1") },
      { mimetype: "image/png", buffer: Buffer.from("img2") },
    ];

    const result = await judgeScreenshots(step(), multipleFiles, "gemini", undefined);

    expect(result.judgement).toBe("OK");
  });
});
