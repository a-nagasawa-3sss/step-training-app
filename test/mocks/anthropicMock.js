// @anthropic-ai/sdk のテスト用モック。
// messages.createの戻り値/エラーをテストごとに差し替えられるよう、jest.fnをそのままexportする。
const mockMessagesCreate = jest.fn();
const Anthropic = jest.fn().mockImplementation(() => ({
  messages: { create: mockMessagesCreate },
}));

module.exports = Anthropic;
module.exports.mockMessagesCreate = mockMessagesCreate;
