// openai のテスト用モック。
// chat.completions.createの戻り値/エラーをテストごとに差し替えられるよう、jest.fnをそのままexportする。
const mockChatCompletionsCreate = jest.fn();
const OpenAI = jest.fn().mockImplementation(() => ({
  chat: { completions: { create: mockChatCompletionsCreate } },
}));

module.exports = OpenAI;
module.exports.mockChatCompletionsCreate = mockChatCompletionsCreate;
