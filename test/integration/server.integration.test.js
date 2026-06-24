// 結合テスト: 実際のExpressアプリ + 実ファイルシステム + 実Gemini APIを使って検証する。
// data/配下の実データは汚さないよう、一時ディレクトリ(STEP_TRAINING_DATA_DIR)に切り替えて実行する。
// Gemini APIを使うテストは、GEMINI_API_KEYが無い環境では自動的にskipする。
const fs = require("fs");
const os = require("os");
const path = require("path");
const request = require("supertest");

const TEMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "step-training-integration-"));
process.env.STEP_TRAINING_DATA_DIR = TEMP_DIR;

fs.mkdirSync(path.join(TEMP_DIR, "courses"), { recursive: true });
fs.writeFileSync(path.join(TEMP_DIR, "courses", "index.json"), "[]");
fs.writeFileSync(path.join(TEMP_DIR, "progress.json"), "{}");
fs.writeFileSync(
  path.join(TEMP_DIR, "steps.json"),
  JSON.stringify({
    title: "組み込みテスト教材",
    subtitle: "",
    steps: [
      {
        id: 1,
        title: "タスク1",
        goalHtml: "<p>g</p>",
        detailHtml: "<p>d</p>",
        checkpoint: { instruction: "i", criteria: ["c1"] },
      },
    ],
  })
);

const app = require("../../server");

const HAS_GEMINI_KEY = !!process.env.GEMINI_API_KEY;
const itWithGemini = HAS_GEMINI_KEY ? it : it.skip;

// 1x1の透明PNG。Gemini側に有効な画像として渡せれば十分で、内容自体は問わない
const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUAAarVyFEAAAAASUVORK5CYII=",
  "base64"
);

if (!HAS_GEMINI_KEY) {
  console.warn(
    "[integration] GEMINI_API_KEY が未設定のため、Gemini APIを実際に呼び出すテストはskipします（.envを確認してください）"
  );
}

afterAll(() => {
  fs.rmSync(TEMP_DIR, { recursive: true, force: true });
});

describe("実サーバー + 実fs (Geminiを使わない範囲)", () => {
  it("コースの作成→取得→進捗保存→削除が一通り行える", async () => {
    const courseId = "integration-course-1";
    const course = {
      title: "結合テスト教材",
      subtitle: "サブ",
      steps: [
        {
          id: 1,
          title: "タスクA",
          goalHtml: "<p>g</p>",
          detailHtml: "<p>d</p>",
          checkpoint: { instruction: "i", criteria: ["基準1", "基準2"] },
        },
      ],
    };
    fs.writeFileSync(path.join(TEMP_DIR, "courses", `${courseId}.json`), JSON.stringify(course));
    const index = [{ id: courseId, title: course.title, subtitle: course.subtitle, builtin: false }];
    fs.writeFileSync(path.join(TEMP_DIR, "courses", "index.json"), JSON.stringify(index));

    const listRes = await request(app).get("/api/courses");
    expect(listRes.status).toBe(200);
    expect(listRes.body.find((c) => c.id === courseId)).toBeDefined();

    const getRes = await request(app).get(`/api/courses/${courseId}`);
    expect(getRes.status).toBe(200);
    expect(getRes.body.title).toBe("結合テスト教材");

    const progressRes = await request(app)
      .post("/api/progress")
      .send({ courseId, stepId: 1, criteria: [true, false] });
    expect(progressRes.status).toBe(200);

    const progressGetRes = await request(app).get(`/api/progress/${courseId}`);
    expect(progressGetRes.body).toEqual({ 1: [true, false] });

    const deleteRes = await request(app).delete(`/api/courses/${courseId}`);
    expect(deleteRes.status).toBe(200);
    expect(fs.existsSync(path.join(TEMP_DIR, "courses", `${courseId}.json`))).toBe(false);
  });

  it("組み込みコース(steps.json)を取得できる", async () => {
    const res = await request(app).get("/api/courses/aws-level1-default");
    expect(res.status).toBe(200);
    expect(res.body.title).toBe("組み込みテスト教材");
  });
});

describe("実Gemini APIを使った結合テスト", () => {
  itWithGemini(
    "問題.mdをGeminiに渡してSTEP教材を生成できる",
    async () => {
      const markdown = [
        "# タスク1: S3バケットの作成",
        "",
        "S3バケットを1つ作成してください。バケット名は任意でよい。",
        "作成後、バケット一覧画面のスクリーンショットを提出すること。",
      ].join("\n");

      const res = await request(app)
        .post("/api/courses/generate")
        .send({ markdown, filename: "integration-test.md" });

      expect(res.status).toBe(200);
      expect(typeof res.body.title).toBe("string");
      expect(res.body.title.length).toBeGreaterThan(0);
      expect(res.body.stepCount).toBeGreaterThan(0);

      const saved = JSON.parse(
        fs.readFileSync(path.join(TEMP_DIR, "courses", `${res.body.id}.json`), "utf-8")
      );
      expect(Array.isArray(saved.steps)).toBe(true);
      expect(saved.steps.length).toBe(res.body.stepCount);
    },
    30000
  );

  itWithGemini(
    "スクリーンショットをGeminiに判定させ、構造化された結果が返る",
    async () => {
      const courseId = "integration-judge-course";
      const course = {
        title: "判定テスト教材",
        subtitle: "",
        steps: [
          {
            id: 1,
            title: "タスク1",
            goalHtml: "<p>g</p>",
            detailHtml: "<p>d</p>",
            checkpoint: {
              instruction: "AWSマネジメントコンソールの画面を提出してください",
              criteria: ["AWSマネジメントコンソールの画面が写っている"],
            },
          },
        ],
      };
      fs.writeFileSync(path.join(TEMP_DIR, "courses", `${courseId}.json`), JSON.stringify(course));

      const res = await request(app)
        .post("/api/judge")
        .field("courseId", courseId)
        .field("stepId", "1")
        .attach("screenshots", ONE_PIXEL_PNG, "shot.png");

      expect(res.status).toBe(200);
      expect(["OK", "NG"]).toContain(res.body.judgement);
      expect(typeof res.body.reason).toBe("string");
      expect(res.body.checks).toEqual([
        expect.objectContaining({ index: 0, item: expect.any(String), passed: expect.any(Boolean) }),
      ]);
    },
    30000
  );
});
