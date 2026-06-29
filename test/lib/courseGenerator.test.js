// lib/courseGenerator.js の単体試験（APIキー設定済みの場合）。
// fsとAI各SDKはtest/mocks配下のモジュールでモック化し、実データやAI APIへの
// 実際の通信を発生させずに「.md → STEP教材JSON」の生成ロジックを直接検証する。
jest.mock("fs", () => require("../mocks/fsMock"));
jest.mock("@google/generative-ai", () => require("../mocks/genAiMock"));
jest.mock("@anthropic-ai/sdk", () => require("../mocks/anthropicMock"));
jest.mock("openai", () => require("../mocks/openAiMock"));

const { mockGenerateContent } = require("../mocks/genAiMock");
const { mockMessagesCreate } = require("../mocks/anthropicMock");
const { mockChatCompletionsCreate } = require("../mocks/openAiMock");
const fsMock = require("../mocks/fsMock");

process.env.GEMINI_API_KEY = "test-api-key";
process.env.ANTHROPIC_API_KEY = "test-claude-key";
process.env.OPENAI_API_KEY = "test-openai-key";

const { validateCourse, generateCourseFromMarkdown } = require("../../lib/courseGenerator");

function geminiText(text) {
  return { response: { text: () => text, candidates: [{ finishReason: "STOP" }] } };
}
function claudeMessage(text, stopReason = "end_turn") {
  return { content: [{ type: "text", text }], stop_reason: stopReason };
}
function openAiCompletion(text, finishReason = "stop") {
  return { choices: [{ message: { content: text }, finish_reason: finishReason }] };
}
function validCourse(overrides = {}) {
  return {
    title: "サンプル教材",
    subtitle: "サブタイトル",
    steps: [
      {
        id: 1,
        title: "タスク1",
        goalHtml: "<p>ゴール</p>",
        detailHtml: "<p>詳細</p>",
        checkpoint: { instruction: "スクショ説明", criteria: ["基準1", "基準2"] },
      },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  fsMock.__store.clear();
  mockGenerateContent.mockReset();
  mockMessagesCreate.mockReset();
  mockChatCompletionsCreate.mockReset();
});

describe("validateCourse", () => {
  const cases = [
    ["オブジェクトでない", "not an object", "JSONオブジェクトではありません"],
    ["titleが不正", validCourse({ title: "" }), "title が不正です"],
    ["subtitleが不正", validCourse({ subtitle: 123 }), "subtitle が不正です"],
    ["stepsが空", validCourse({ steps: [] }), "steps が空です"],
    ["step.idが不正", validCourse({ steps: [{ ...validCourse().steps[0], id: "1" }] }), "steps[0].id が不正です"],
    [
      "step.titleが不正",
      validCourse({ steps: [{ ...validCourse().steps[0], title: "" }] }),
      "steps[0].title が不正です",
    ],
    [
      "step.goalHtmlが不正",
      validCourse({ steps: [{ ...validCourse().steps[0], goalHtml: undefined }] }),
      "steps[0].goalHtml が不正です",
    ],
    [
      "step.detailHtmlが不正",
      validCourse({ steps: [{ ...validCourse().steps[0], detailHtml: undefined }] }),
      "steps[0].detailHtml が不正です",
    ],
    [
      "checkpoint.instructionが不正",
      validCourse({ steps: [{ ...validCourse().steps[0], checkpoint: { criteria: ["x"] } }] }),
      "steps[0].checkpoint.instruction が不正です",
    ],
    [
      "checkpoint.criteriaが空",
      validCourse({ steps: [{ ...validCourse().steps[0], checkpoint: { instruction: "i", criteria: [] } }] }),
      "steps[0].checkpoint.criteria が不正です",
    ],
  ];

  it.each(cases)("%s はエラーを投げる", (_label, course, expectedMessage) => {
    expect(() => validateCourse(course)).toThrow(expectedMessage);
  });

  it("妥当な教材はエラーを投げない", () => {
    expect(() => validateCourse(validCourse())).not.toThrow();
  });
});

describe("generateCourseFromMarkdown", () => {
  it("Geminiの応答から教材JSONを生成し、進捗をmd_loaded→ai_generatedの順で通知する", async () => {
    const course = validCourse();
    mockGenerateContent.mockResolvedValueOnce(geminiText(JSON.stringify(course)));
    const onProgress = jest.fn();

    const result = await generateCourseFromMarkdown("# 問題", "gemini", onProgress);

    expect(result).toEqual(course);
    expect(onProgress.mock.calls.map((c) => c[0])).toEqual(["md_loaded", "ai_generated"]);
  });

  it("aiProvider=claudeの場合はClaude APIで生成する", async () => {
    const course = validCourse();
    mockMessagesCreate.mockResolvedValueOnce(claudeMessage(JSON.stringify(course)));

    const result = await generateCourseFromMarkdown("# 問題", "claude");

    expect(result).toEqual(course);
    expect(mockMessagesCreate).toHaveBeenCalledTimes(1);
    expect(mockGenerateContent).not.toHaveBeenCalled();
  });

  it("aiProvider=openaiの場合はOpenAI APIで生成する", async () => {
    const course = validCourse();
    mockChatCompletionsCreate.mockResolvedValueOnce(openAiCompletion(JSON.stringify(course)));

    const result = await generateCourseFromMarkdown("# 問題", "openai");

    expect(result).toEqual(course);
    expect(mockChatCompletionsCreate).toHaveBeenCalledTimes(1);
  });

  it("Claudeの応答がmax_tokensで途中で切れた場合は出力上限エラーを投げる", async () => {
    mockMessagesCreate.mockResolvedValueOnce(claudeMessage('{"title":"切れた応答"', "max_tokens"));
    await expect(generateCourseFromMarkdown("# 問題", "claude")).rejects.toThrow("出力上限に達し");
  });

  it("OpenAIの応答がfinish_reason=lengthで途中で切れた場合は出力上限エラーを投げる", async () => {
    mockChatCompletionsCreate.mockResolvedValueOnce(openAiCompletion('{"title":"切れた応答"', "length"));
    await expect(generateCourseFromMarkdown("# 問題", "openai")).rejects.toThrow("出力上限に達し");
  });

  it("```json フェンス付きの応答もJSONとして解釈できる", async () => {
    const course = validCourse();
    mockGenerateContent.mockResolvedValueOnce(geminiText("```json\n" + JSON.stringify(course) + "\n```"));
    await expect(generateCourseFromMarkdown("# 問題", "gemini")).resolves.toEqual(course);
  });

  it("文字列内に生の改行が混在していてもJSONとして解釈できる(コードブロック転記時の典型パターン)", async () => {
    const course = validCourse({
      steps: [{ ...validCourse().steps[0], detailHtml: "<pre><code>line1\nline2\nline3</code></pre>" }],
    });
    const broken = JSON.stringify(course).replace(/\\n/g, "\n");
    mockGenerateContent.mockResolvedValueOnce(geminiText(broken));
    await expect(generateCourseFromMarkdown("# 問題", "gemini")).resolves.toEqual(course);
  });

  it("AIの呼び出しが失敗(リトライ対象外)した場合はそのままエラーを投げる", async () => {
    mockGenerateContent.mockRejectedValueOnce(new Error("APIキーが不正です"));
    await expect(generateCourseFromMarkdown("# 問題", "gemini")).rejects.toThrow("APIキーが不正です");
  });

  it("応答がJSONとして解釈できない場合はエラーを投げる", async () => {
    mockGenerateContent.mockResolvedValueOnce(geminiText("これはJSONではありません"));
    await expect(generateCourseFromMarkdown("# 問題", "gemini")).rejects.toThrow(
      "AIの出力をJSONとして解釈できませんでした"
    );
  });

  it("スキーマ不正な場合はvalidateCourseのエラーを投げる", async () => {
    mockGenerateContent.mockResolvedValueOnce(geminiText(JSON.stringify(validCourse({ steps: [] }))));
    await expect(generateCourseFromMarkdown("# 問題", "gemini")).rejects.toThrow("steps が空です");
  });

  it("デバッグ用レスポンスの保存に失敗してもコース生成自体は成功する", async () => {
    const consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const course = validCourse();
    mockGenerateContent.mockResolvedValueOnce(geminiText(JSON.stringify(course)));
    fsMock.writeFileSync.mockImplementationOnce(() => {
      throw new Error("disk full");
    });

    await expect(generateCourseFromMarkdown("# 問題", "gemini")).resolves.toEqual(course);
    expect(consoleErrorSpy).toHaveBeenCalledWith("デバッグ用レスポンスの保存に失敗しました", expect.any(Error));
    consoleErrorSpy.mockRestore();
  });
});
