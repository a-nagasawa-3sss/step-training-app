// server.js の単体試験。
// 各コンポーネント(lib/*)の処理ロジック自体はtest/lib/配下で個別に検証済みのため、
// ここではエンドポイントの配線（ルーティング・入力検証・各コンポーネントの呼び出し結果の
// レスポンスへの反映・ファイル一覧/進捗の更新)に範囲を絞って検証する。
//
// fs と @google/generative-ai 等は test/mocks 配下のモジュールでモック化し、
// 実データ(data/配下)やAPIへの実際の通信を発生させずに検証する。
jest.mock("fs", () => require("./mocks/fsMock"));
jest.mock("@google/generative-ai", () => require("./mocks/genAiMock"));
jest.mock("@anthropic-ai/sdk", () => require("./mocks/anthropicMock"));
jest.mock("openai", () => require("./mocks/openAiMock"));

const path = require("path");
const request = require("supertest");
const fsMock = require("./mocks/fsMock");
const { mockGenerateContent } = require("./mocks/genAiMock");
const { mockMessagesCreate } = require("./mocks/anthropicMock");
const { mockChatCompletionsCreate } = require("./mocks/openAiMock");

process.env.GEMINI_API_KEY = "test-api-key";
process.env.ANTHROPIC_API_KEY = "test-claude-key";
process.env.OPENAI_API_KEY = "test-openai-key";
const app = require("../server");

const DATA_DIR = fsMock.__DATA_DIR;
const COURSES_DIR = path.join(DATA_DIR, "courses");
const COURSE_INDEX_PATH = path.join(COURSES_DIR, "index.json");
const PROGRESS_PATH = path.join(DATA_DIR, "progress.json");
const DEFAULT_COURSE_PATH = path.join(DATA_DIR, "steps.json");
const DEFAULT_COURSE_ID = "aws-level1-default";

function courseFilePath(id) {
  return path.join(COURSES_DIR, `${id}.json`);
}
function seedIndex(entries) {
  fsMock.__store.set(COURSE_INDEX_PATH, JSON.stringify(entries));
}
function seedCourse(id, course) {
  fsMock.__store.set(courseFilePath(id), JSON.stringify(course));
}
function seedProgress(data) {
  fsMock.__store.set(PROGRESS_PATH, JSON.stringify(data));
}
function geminiText(text) {
  return { response: { text: () => text } };
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

function claudeMessage(text, stopReason = "end_turn") {
  return { content: [{ type: "text", text }], stop_reason: stopReason };
}

beforeEach(() => {
  fsMock.__store.clear();
  mockGenerateContent.mockReset();
  mockMessagesCreate.mockReset();
  mockChatCompletionsCreate.mockReset();
});

// ============================================================
// GET /api/providers
// ============================================================
describe("GET /api/providers", () => {
  it("各プロバイダーのキー設定状況とモデル名を返す", async () => {
    const res = await request(app).get("/api/providers");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      gemini: { available: true, model: "gemini-2.5-flash-lite" },
      claude: { available: true, model: "claude-haiku-4-5" },
      openai: { available: true, model: "gpt-5-mini" },
    });
  });
});

// ============================================================
// GET /api/courses
// ============================================================
describe("GET /api/courses", () => {
  it("一覧ファイルが無い場合は空配列を返す", async () => {
    const res = await request(app).get("/api/courses");
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("保存済みの一覧を返す", async () => {
    seedIndex([{ id: "abc", title: "T", subtitle: "S", builtin: false }]);
    const res = await request(app).get("/api/courses");
    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ id: "abc", title: "T", subtitle: "S", builtin: false }]);
  });
});

// ============================================================
// GET /api/courses/:id
// ============================================================
describe("GET /api/courses/:id", () => {
  it("存在しないコースは404", async () => {
    const res = await request(app).get("/api/courses/unknown");
    expect(res.status).toBe(404);
    expect(res.body.error).toBeDefined();
  });

  it("生成済みコースの教材本体を返す", async () => {
    const course = validCourse();
    seedCourse("abc", course);
    const res = await request(app).get("/api/courses/abc");
    expect(res.status).toBe(200);
    expect(res.body).toEqual(course);
  });

  it("組み込みコース(aws-level1-default)はsteps.jsonから読む", async () => {
    const course = validCourse({ title: "組み込み教材" });
    fsMock.__store.set(DEFAULT_COURSE_PATH, JSON.stringify(course));
    const res = await request(app).get(`/api/courses/${DEFAULT_COURSE_ID}`);
    expect(res.status).toBe(200);
    expect(res.body.title).toBe("組み込み教材");
  });
});

// ============================================================
// POST /api/courses/generate
//   個々のAIプロバイダー分岐・JSON解釈・スキーマ検証はlib/courseGenerator.test.jsで検証済み。
//   ここではエンドポイントとしての入力検証・コース保存・一覧更新の配線のみを確認する。
// ============================================================
describe("POST /api/courses/generate", () => {
  it("markdownが無い場合は400", async () => {
    const res = await request(app).post("/api/courses/generate").send({});
    expect(res.status).toBe(400);
  });

  it("markdownが空白のみの場合は400", async () => {
    const res = await request(app).post("/api/courses/generate").send({ markdown: "   " });
    expect(res.status).toBe(400);
  });

  it("生成したコースを保存し、一覧にメタ情報を追加する", async () => {
    const course = validCourse();
    mockGenerateContent.mockResolvedValueOnce(geminiText(JSON.stringify(course)));

    const res = await request(app)
      .post("/api/courses/generate")
      .send({ markdown: "# 問題", filename: "q.md" });

    expect(res.status).toBe(200);
    expect(res.body.title).toBe(course.title);
    expect(res.body.stepCount).toBe(1);
    expect(res.body.id).toBeTruthy();

    const index = JSON.parse(fsMock.__store.get(COURSE_INDEX_PATH));
    expect(index).toHaveLength(1);
    expect(index[0]).toMatchObject({
      id: res.body.id,
      title: course.title,
      subtitle: course.subtitle,
      sourceFilename: "q.md",
      aiProvider: "gemini",
      aiModel: "gemini-2.5-flash-lite",
      builtin: false,
    });
    expect(JSON.parse(fsMock.__store.get(courseFilePath(res.body.id)))).toEqual(course);
  });

  it("aiProviderを指定すると一覧のメタ情報にも反映される", async () => {
    const course = validCourse();
    mockMessagesCreate.mockResolvedValueOnce(claudeMessage(JSON.stringify(course)));

    const res = await request(app)
      .post("/api/courses/generate")
      .send({ markdown: "# 問題", aiProvider: "claude" });

    expect(res.status).toBe(200);
    const index = JSON.parse(fsMock.__store.get(COURSE_INDEX_PATH));
    expect(index[0]).toMatchObject({ aiProvider: "claude", aiModel: "claude-haiku-4-5" });
  });

  it("コース生成に失敗した場合は500とエラーメッセージを返す", async () => {
    mockGenerateContent.mockRejectedValueOnce(new Error("APIキーが不正です"));
    const res = await request(app).post("/api/courses/generate").send({ markdown: "# 問題" });
    expect(res.status).toBe(500);
    expect(res.body.error).toContain("コースの生成に失敗しました");
  });
});

// ============================================================
// POST /api/courses/:id/regenerate
// ============================================================
describe("POST /api/courses/:id/regenerate", () => {
  it("存在しないコースは404", async () => {
    const res = await request(app).post("/api/courses/unknown/regenerate").send({ markdown: "# 問題" });
    expect(res.status).toBe(404);
  });

  it("組み込みコースは再生成不可で400", async () => {
    seedIndex([{ id: DEFAULT_COURSE_ID, title: "T", builtin: true }]);
    const res = await request(app)
      .post(`/api/courses/${DEFAULT_COURSE_ID}/regenerate`)
      .send({ markdown: "# 問題" });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("組み込みコース");
  });

  it("markdownが無い場合は400", async () => {
    seedIndex([{ id: "abc", title: "T", builtin: false }]);
    const res = await request(app).post("/api/courses/abc/regenerate").send({});
    expect(res.status).toBe(400);
  });

  it("再生成に成功すると一覧と進捗が更新される", async () => {
    seedIndex([{ id: "abc", title: "旧title", subtitle: "旧sub", builtin: false, sourceFilename: "old.md" }]);
    seedCourse("abc", validCourse({ title: "旧title" }));
    seedProgress({ abc: { 1: [true, true] } });

    const newCourse = validCourse({ title: "新title", subtitle: "新sub" });
    mockGenerateContent.mockResolvedValueOnce(geminiText(JSON.stringify(newCourse)));

    const res = await request(app)
      .post("/api/courses/abc/regenerate")
      .send({ markdown: "# 新問題", filename: "new.md" });

    expect(res.status).toBe(200);
    expect(res.body.title).toBe("新title");

    const index = JSON.parse(fsMock.__store.get(COURSE_INDEX_PATH));
    expect(index[0]).toMatchObject({
      title: "新title",
      subtitle: "新sub",
      sourceFilename: "new.md",
      aiProvider: "gemini",
      aiModel: "gemini-2.5-flash-lite",
    });
    expect(index[0].updatedAt).toBeDefined();

    const progress = JSON.parse(fsMock.__store.get(PROGRESS_PATH));
    expect(progress.abc).toEqual({});
  });

  it("filenameを省略した場合は既存のsourceFilenameを保持する", async () => {
    seedIndex([{ id: "abc", title: "旧", builtin: false, sourceFilename: "old.md" }]);
    seedCourse("abc", validCourse());
    mockGenerateContent.mockResolvedValueOnce(geminiText(JSON.stringify(validCourse({ title: "新" }))));

    const res = await request(app).post("/api/courses/abc/regenerate").send({ markdown: "# 新問題" });
    expect(res.status).toBe(200);
    const index = JSON.parse(fsMock.__store.get(COURSE_INDEX_PATH));
    expect(index[0].sourceFilename).toBe("old.md");
  });

  it("コース生成に失敗した場合は500", async () => {
    seedIndex([{ id: "abc", title: "旧", builtin: false }]);
    mockGenerateContent.mockRejectedValueOnce(new Error("失敗"));
    const res = await request(app).post("/api/courses/abc/regenerate").send({ markdown: "# 問題" });
    expect(res.status).toBe(500);
    expect(res.body.error).toContain("コースの再生成に失敗しました");
  });
});

// ============================================================
// DELETE /api/courses/:id
// ============================================================
describe("DELETE /api/courses/:id", () => {
  it("存在しないコースは404", async () => {
    const res = await request(app).delete("/api/courses/unknown");
    expect(res.status).toBe(404);
  });

  it("組み込みコースは削除不可で400", async () => {
    seedIndex([{ id: DEFAULT_COURSE_ID, title: "T", builtin: true }]);
    const res = await request(app).delete(`/api/courses/${DEFAULT_COURSE_ID}`);
    expect(res.status).toBe(400);
  });

  it("コースと進捗を削除する", async () => {
    seedIndex([{ id: "abc", title: "T", builtin: false }]);
    seedCourse("abc", validCourse());
    seedProgress({ abc: { 1: [true] } });

    const res = await request(app).delete("/api/courses/abc");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    expect(JSON.parse(fsMock.__store.get(COURSE_INDEX_PATH))).toEqual([]);
    expect(fsMock.__store.has(courseFilePath("abc"))).toBe(false);
    expect(JSON.parse(fsMock.__store.get(PROGRESS_PATH)).abc).toBeUndefined();
  });

  it("教材ファイルが既に無くても削除は成功する", async () => {
    seedIndex([{ id: "abc", title: "T", builtin: false }]);
    const res = await request(app).delete("/api/courses/abc");
    expect(res.status).toBe(200);
  });
});

// ============================================================
// 進捗API
// ============================================================
describe("GET /api/progress/:courseId", () => {
  it("進捗ファイルが無い場合は空オブジェクト", async () => {
    const res = await request(app).get("/api/progress/abc");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
  });

  it("対象コースの進捗が無い場合は空オブジェクト", async () => {
    seedProgress({ other: { 1: [true] } });
    const res = await request(app).get("/api/progress/abc");
    expect(res.body).toEqual({});
  });

  it("保存済みの進捗を返す", async () => {
    seedProgress({ abc: { 1: [true, false] } });
    const res = await request(app).get("/api/progress/abc");
    expect(res.body).toEqual({ 1: [true, false] });
  });
});

describe("POST /api/progress", () => {
  it.each([
    [{ stepId: 1, criteria: [] }],
    [{ courseId: "abc", criteria: [] }],
    [{ courseId: "abc", stepId: 1 }],
    [{ courseId: "abc", stepId: "1", criteria: [] }],
  ])("不正なリクエストは400 (%o)", async (body) => {
    const res = await request(app).post("/api/progress").send(body);
    expect(res.status).toBe(400);
  });

  it("進捗を保存する", async () => {
    const res = await request(app)
      .post("/api/progress")
      .send({ courseId: "abc", stepId: 1, criteria: [true, false] });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const stored = JSON.parse(fsMock.__store.get(PROGRESS_PATH));
    expect(stored).toEqual({ abc: { 1: [true, false] } });
  });
});

// ============================================================
// POST /api/judge
//   判定基準の絞り込み・合否算出ロジック自体はlib/judge.test.jsで検証済み。
//   ここではエンドポイントとしての入力検証・lib/judgeの呼び出し結果の反映のみを確認する。
// ============================================================
describe("POST /api/judge", () => {
  it("不正なcourseId/stepIdは400", async () => {
    const res = await request(app).post("/api/judge").field("courseId", "unknown").field("stepId", "1");
    expect(res.status).toBe(400);
  });

  it("courseは存在するがstepが無い場合は400", async () => {
    seedCourse("abc", validCourse());
    const res = await request(app).post("/api/judge").field("courseId", "abc").field("stepId", "999");
    expect(res.status).toBe(400);
  });

  it("スクリーンショットが無い場合は400", async () => {
    seedCourse("abc", validCourse());
    const res = await request(app).post("/api/judge").field("courseId", "abc").field("stepId", "1");
    expect(res.status).toBe(400);
    expect(mockGenerateContent).not.toHaveBeenCalled();
  });

  it("判定に成功した場合は結果をそのままレスポンスに反映する", async () => {
    seedCourse("abc", validCourse());
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

    const res = await request(app)
      .post("/api/judge")
      .field("courseId", "abc")
      .field("stepId", "1")
      .attach("screenshots", Buffer.from("fake-image"), "shot.png");

    expect(res.status).toBe(200);
    expect(res.body.judgement).toBe("NG");
    expect(res.body.checks).toEqual([
      { index: 0, item: "基準1", passed: true },
      { index: 1, item: "基準2", passed: false },
    ]);
  });

  it("AI呼び出しが失敗した場合は500とプロバイダー名入りのエラーメッセージを返す", async () => {
    seedCourse("abc", validCourse());
    mockGenerateContent.mockRejectedValueOnce(new Error("呼び出し失敗"));

    const res = await request(app)
      .post("/api/judge")
      .field("courseId", "abc")
      .field("stepId", "1")
      .attach("screenshots", Buffer.from("fake-image"), "shot.png");

    expect(res.status).toBe(500);
    expect(res.body.error).toContain("Gemini API の呼び出しに失敗しました");
  });
});

// ============================================================
// 静的ファイル配信
// ============================================================
describe("静的ファイル配信", () => {
  it("/ はpublic/index.htmlを返す", async () => {
    const res = await request(app).get("/");
    expect(res.status).toBe(200);
    expect(res.text).toContain("<html");
  });
});
