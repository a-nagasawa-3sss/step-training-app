// 結合テスト専用のJest設定。
// npm test（通常の単体試験）には含めず、npm run test:integration で明示的に実行する。
// 実Gemini APIを呼び出すため時間がかかり、APIクォータも消費するため。
module.exports = {
  rootDir: "../../",
  displayName: "integration",
  testEnvironment: "node",
  testMatch: ["<rootDir>/test/integration/**/*.test.js"],
  testTimeout: 30000,
};
