// @anthropic-ai/sdk のテスト用モック。
// messages.createの戻り値/エラーをテストごとに差し替えられるよう、jest.fnをそのままexportする。
const mockMessagesCreate = jest.fn();
const Anthropic = jest.fn().mockImplementation(() => ({
  messages: {
    create: mockMessagesCreate,
    // stream()はSDKの実際の戻り値（MessageStream）を模して、finalMessage()で
    // create()と同じモックの結果（成功/失敗）を返すようにする。
    stream: (...args) => ({
      finalMessage: () => mockMessagesCreate(...args),
    }),
  },
}));

module.exports = Anthropic;
module.exports.mockMessagesCreate = mockMessagesCreate;
