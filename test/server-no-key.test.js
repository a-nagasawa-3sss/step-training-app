// GEMINI_API_KEY / ANTHROPIC_API_KEY / OPENAI_API_KEY が未設定のときの挙動だけを検証する専用ファイル。
// server.js は起動時にこれらの環境変数を読んでgenAI/anthropic/openaiを初期化するため、
// 他のテスト(キー設定済み)と同じモジュールキャッシュを共有しないよう別ファイルに分離している。
jest.mock("fs", () => require("./mocks/fsMock"));
jest.mock("@google/generative-ai", () => require("./mocks/genAiMock"));
jest.mock("@anthropic-ai/sdk", () => require("./mocks/anthropicMock"));
jest.mock("openai", () => require("./mocks/openAiMock"));

const request = require("supertest");
const fsMock = require("./mocks/fsMock");

// 空文字を設定しておくことで、dotenvが.envファイルの値で上書きしないようにする
// (dotenvはprocess.envに既にキーが存在する場合は上書きしない仕様)
process.env.GEMINI_API_KEY = "";
process.env.ANTHROPIC_API_KEY = "";
process.env.OPENAI_API_KEY = "";
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

describe("GET /api/providers", () => {
  it("すべて未設定の場合はfalseを返す", async () => {
    const res = await request(app).get("/api/providers");
    expect(res.body).toEqual({
      gemini: { available: false, model: "gemini-2.5-flash-lite" },
      claude: { available: false, model: "claude-haiku-4-5" },
      openai: { available: false, model: "gpt-5-mini" },
    });
  });
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

describe("ANTHROPIC_API_KEY未設定時", () => {
  it("aiProvider=claudeでのコース生成は500になる", async () => {
    const res = await request(app)
      .post("/api/courses/generate")
      .send({ markdown: "# 問題", aiProvider: "claude" });
    expect(res.status).toBe(500);
    expect(res.body.error).toContain("ANTHROPIC_API_KEY が設定されていません");
  });

  it("aiProvider=claudeでのスクリーンショット判定は500になる", async () => {
    seedCourse("abc", {
      title: "T",
      subtitle: "",
      steps: [{ id: 1, title: "t", goalHtml: "", detailHtml: "", checkpoint: { instruction: "i", criteria: ["c"] } }],
    });
    const res = await request(app)
      .post("/api/judge")
      .field("courseId", "abc")
      .field("stepId", "1")
      .field("aiProvider", "claude")
      .attach("screenshots", Buffer.from("img"), "shot.png");
    expect(res.status).toBe(500);
    expect(res.body.error).toContain("ANTHROPIC_API_KEY が設定されていません");
  });
});

describe("OPENAI_API_KEY未設定時", () => {
  it("aiProvider=openaiでのコース生成は500になる", async () => {
    const res = await request(app)
      .post("/api/courses/generate")
      .send({ markdown: "# 問題", aiProvider: "openai" });
    expect(res.status).toBe(500);
    expect(res.body.error).toContain("OPENAI_API_KEY が設定されていません");
  });

  it("aiProvider=openaiでのスクリーンショット判定は500になる", async () => {
    seedCourse("abc", {
      title: "T",
      subtitle: "",
      steps: [{ id: 1, title: "t", goalHtml: "", detailHtml: "", checkpoint: { instruction: "i", criteria: ["c"] } }],
    });
    const res = await request(app)
      .post("/api/judge")
      .field("courseId", "abc")
      .field("stepId", "1")
      .field("aiProvider", "openai")
      .attach("screenshots", Buffer.from("img"), "shot.png");
    expect(res.status).toBe(500);
    expect(res.body.error).toContain("OPENAI_API_KEY が設定されていません");
  });
});
