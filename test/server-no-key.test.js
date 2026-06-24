// GEMINI_API_KEY が未設定のときの挙動だけを検証する専用ファイル。
// server.js は起動時に process.env.GEMINI_API_KEY を読んでgenAIを初期化するため、
// 他のテスト(キー設定済み)と同じモジュールキャッシュを共有しないよう別ファイルに分離している。
jest.mock("fs", () => require("./mocks/fsMock"));
jest.mock("@google/generative-ai", () => require("./mocks/genAiMock"));

const request = require("supertest");
const fsMock = require("./mocks/fsMock");

// 空文字を設定しておくことで、dotenvが.envファイルのGEMINI_API_KEYで上書きしないようにする
// (dotenvはprocess.envに既にキーが存在する場合は上書きしない仕様)
process.env.GEMINI_API_KEY = "";
const app = require("../server");

const path = require("path");
const COURSES_DIR = path.join(fsMock.__DATA_DIR, "courses");
const COURSE_INDEX_PATH = path.join(COURSES_DIR, "index.json");

function seedCourse(id, course) {
  fsMock.__store.set(path.join(COURSES_DIR, `${id}.json`), JSON.stringify(course));
}

beforeEach(() => {
  fsMock.__store.clear();
});

describe("GEMINI_API_KEY未設定時", () => {
  it("コース生成は500になる", async () => {
    const res = await request(app).post("/api/courses/generate").send({ markdown: "# 問題" });
    expect(res.status).toBe(500);
    expect(res.body.error).toContain("GEMINI_API_KEY が設定されていません");
  });

  it("スクリーンショット判定は500になる", async () => {
    seedCourse("abc", {
      title: "T",
      subtitle: "",
      steps: [{ id: 1, title: "t", goalHtml: "", detailHtml: "", checkpoint: { instruction: "i", criteria: ["c"] } }],
    });
    const res = await request(app)
      .post("/api/judge")
      .field("courseId", "abc")
      .field("stepId", "1")
      .attach("screenshots", Buffer.from("img"), "shot.png");
    expect(res.status).toBe(500);
    expect(res.body.error).toContain("GEMINI_API_KEY が設定されていません");
  });
});
