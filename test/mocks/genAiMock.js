// @google/generative-ai のテスト用モック。
// generateContentの戻り値/エラーをテストごとに差し替えられるよう、jest.fnをそのままexportする。
const mockGenerateContent = jest.fn();
const mockGetGenerativeModel = jest.fn(() => ({ generateContent: mockGenerateContent }));
const GoogleGenerativeAI = jest.fn().mockImplementation(() => ({
  getGenerativeModel: mockGetGenerativeModel,
}));

module.exports = { GoogleGenerativeAI, mockGenerateContent, mockGetGenerativeModel };
