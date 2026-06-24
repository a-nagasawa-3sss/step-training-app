// public/app.js の単体試験。
// app.jsはDOM操作中心のスクリプトで関数をexportしていないため、index.htmlをjsdomに読み込み、
// fetch/FileReader/confirm/alert等をモックした上でDOMイベントを発火させて挙動を検証する。
const fs = require("fs");
const path = require("path");

const HTML = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf-8");
const APP_JS_PATH = path.join(__dirname, "..", "public", "app.js");

function flush(times = 1) {
  let p = Promise.resolve();
  for (let i = 0; i < times; i++) {
    p = p.then(() => new Promise((resolve) => setTimeout(resolve, 0)));
  }
  return p;
}

/**
 * routes: [{ method, match: RegExp|fn, handler: (url, opts) => ({status, body}) }]
 * デフォルトでGET /api/coursesを空配列で応答するルートを先頭に積んでおき、
 * init()内の初回読み込みが失敗しないようにする。
 */
function setupFetchMock(routes = []) {
  const allRoutes = [
    ...routes,
    { method: "GET", match: /\/api\/courses$/, handler: () => ({ body: [] }) },
  ];
  global.fetch = jest.fn((url, opts = {}) => {
    const method = (opts.method || "GET").toUpperCase();
    const route = allRoutes.find(
      (r) => r.method === method && (typeof r.match === "function" ? r.match(url) : r.match.test(url))
    );
    if (!route) {
      return Promise.reject(new Error(`unhandled fetch: ${method} ${url}`));
    }
    const result = route.handler(url, opts) || {};
    const status = result.status ?? 200;
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      json: async () => result.body,
    });
  });
  return global.fetch;
}

function loadApp() {
  jest.resetModules();
  document.documentElement.innerHTML = HTML;
  return require(APP_JS_PATH);
}

beforeEach(() => {
  window.URL.createObjectURL = jest.fn(() => "blob:mock-url");
  window.confirm = jest.fn(() => true);
  window.alert = jest.fn();
});

afterEach(() => {
  jest.restoreAllMocks();
});

// ============================================================
// ライブラリ画面
// ============================================================
describe("ライブラリ画面", () => {
  it("コースが無い場合は案内文を表示する", async () => {
    setupFetchMock();
    loadApp();
    await flush(2);
    expect(document.getElementById("course-list").textContent).toContain("まだ問題が登録されていません");
  });

  it("コース一覧をカードとして描画する(組み込みコースは再生成/削除ボタンを出さない)", async () => {
    setupFetchMock([
      {
        method: "GET",
        match: /\/api\/courses$/,
        handler: () => ({
          body: [
            { id: "builtin-1", title: "組み込み<script>", subtitle: "初級", builtin: true },
            { id: "gen-1", title: "生成コース", subtitle: "", sourceFilename: "q.md", builtin: false },
          ],
        }),
      },
    ]);
    loadApp();
    await flush(2);

    const cards = document.querySelectorAll(".course-card");
    expect(cards).toHaveLength(2);
    // builtinはタイトルがエスケープされ、再生成/削除ボタンが無い
    expect(cards[0].querySelector(".name").innerHTML).not.toContain("<script>");
    expect(cards[0].querySelectorAll("button")).toHaveLength(1);
    // 生成コースは再生成・削除ボタンを含む3つのボタン
    expect(cards[1].querySelectorAll("button")).toHaveLength(3);
  });

  it("開始ボタンでコース画面に切り替わり、最初のSTEPが表示される", async () => {
    setupFetchMock([
      {
        method: "GET",
        match: /\/api\/courses$/,
        handler: () => ({ body: [{ id: "c1", title: "コース1", subtitle: "", builtin: false }] }),
      },
      {
        method: "GET",
        match: /\/api\/courses\/c1$/,
        handler: () => ({
          body: {
            title: "コース1",
            subtitle: "サブ",
            steps: [
              {
                id: 1,
                title: "タスク1",
                goalHtml: "<p>ゴール1</p>",
                detailHtml: "<p>詳細1</p>",
                checkpoint: { instruction: "指示1", criteria: ["基準A", "基準B"] },
              },
              {
                id: 2,
                title: "タスク2",
                goalHtml: "<p>ゴール2</p>",
                detailHtml: "<p>詳細2</p>",
                checkpoint: { instruction: "指示2", criteria: ["基準C"] },
              },
            ],
          },
        }),
      },
      { method: "GET", match: /\/api\/progress\/c1$/, handler: () => ({ body: {} }) },
    ]);
    loadApp();
    await flush(2);

    document.querySelector(".start-button").click();
    await flush(2);

    expect(document.getElementById("course-screen").style.display).toBe("block");
    expect(document.getElementById("library-screen").style.display).toBe("none");
    expect(document.getElementById("step-title").textContent).toBe("タスク1");
    expect(document.getElementById("header-subtitle").textContent).toContain("コース1");
    expect(document.querySelectorAll("#step-nav button")).toHaveLength(2);
    expect(document.getElementById("prev-button").disabled).toBe(true);
    expect(document.getElementById("next-button").disabled).toBe(false);
  });

  it("保存済み進捗が全合格のSTEPにはnavで passed クラスが付く", async () => {
    setupFetchMock([
      {
        method: "GET",
        match: /\/api\/courses$/,
        handler: () => ({ body: [{ id: "c1", title: "コース1", builtin: false }] }),
      },
      {
        method: "GET",
        match: /\/api\/courses\/c1$/,
        handler: () => ({
          body: {
            title: "コース1",
            subtitle: "",
            steps: [
              { id: 1, title: "タスク1", goalHtml: "", detailHtml: "", checkpoint: { instruction: "i", criteria: ["a"] } },
            ],
          },
        }),
      },
      { method: "GET", match: /\/api\/progress\/c1$/, handler: () => ({ body: { 1: [true] } }) },
    ]);
    loadApp();
    await flush(2);
    document.querySelector(".start-button").click();
    await flush(2);

    expect(document.querySelector("#step-nav button").classList.contains("passed")).toBe(true);
  });

  it("コース読み込みに失敗した場合はalertを表示する", async () => {
    setupFetchMock([
      {
        method: "GET",
        match: /\/api\/courses$/,
        handler: () => ({ body: [{ id: "c1", title: "コース1", builtin: false }] }),
      },
      { method: "GET", match: /\/api\/courses\/c1$/, handler: () => ({ status: 404, body: { error: "not found" } }) },
      { method: "GET", match: /\/api\/progress\/c1$/, handler: () => ({ body: {} }) },
    ]);
    loadApp();
    await flush(2);
    document.querySelector(".start-button").click();
    await flush(2);

    expect(window.alert).toHaveBeenCalledWith("コースの読み込みに失敗しました。");
  });

  it("削除ボタン: confirmでOKした場合だけ削除APIを呼び一覧を再取得する", async () => {
    const fetchMock = setupFetchMock([
      {
        method: "GET",
        match: /\/api\/courses$/,
        handler: () => ({ body: [{ id: "c1", title: "コース1", builtin: false }] }),
      },
      { method: "DELETE", match: /\/api\/courses\/c1$/, handler: () => ({ body: { ok: true } }) },
    ]);
    loadApp();
    await flush(2);

    window.confirm.mockReturnValueOnce(false);
    document.querySelector(".delete-button").click();
    await flush(2);
    expect(fetchMock).not.toHaveBeenCalledWith(expect.stringContaining("/api/courses/c1"), expect.anything());

    window.confirm.mockReturnValueOnce(true);
    document.querySelector(".delete-button").click();
    await flush(2);
    expect(fetchMock).toHaveBeenCalledWith("/api/courses/c1", { method: "DELETE" });
  });
});

// ============================================================
// .md読み込み・コース生成
// ============================================================
describe("問題(.md)の読み込みと生成", () => {
  it(".md選択でファイル内容を読み込み、生成ボタンが有効になる", async () => {
    setupFetchMock();
    loadApp();
    await flush(2);

    const input = document.getElementById("md-file-input");
    const file = new File(["# 研修問題"], "q.md", { type: "text/markdown" });
    Object.defineProperty(input, "files", { value: [file] });
    input.dispatchEvent(new Event("change"));
    await flush(3);

    expect(document.getElementById("generate-button").disabled).toBe(false);
  });

  it("ファイル未選択に戻すと生成ボタンが無効化される", async () => {
    setupFetchMock();
    loadApp();
    await flush(2);

    const input = document.getElementById("md-file-input");
    Object.defineProperty(input, "files", { value: [] });
    input.dispatchEvent(new Event("change"));
    await flush(1);

    expect(document.getElementById("generate-button").disabled).toBe(true);
  });

  it("mdを選択していない状態で生成ボタンを押すとエラー表示になる", async () => {
    setupFetchMock();
    loadApp();
    await flush(2);

    // 通常はmd未選択だとボタンがdisabledのままクリックできないため、
    // 内部のガード処理(mdText未設定時のエラー表示)を直接検証するために強制的に有効化する
    const generateButton = document.getElementById("generate-button");
    generateButton.disabled = false;
    generateButton.click();
    await flush(1);

    expect(document.getElementById("generate-status").className).toBe("ng");
  });

  it("新規生成に成功すると結果表示と「開始する」ボタンが現れる", async () => {
    setupFetchMock([
      {
        method: "POST",
        match: /\/api\/courses\/generate$/,
        handler: () => ({ body: { id: "new-1", title: "新教材", subtitle: "", stepCount: 3 } }),
      },
    ]);
    loadApp();
    await flush(2);

    const input = document.getElementById("md-file-input");
    const file = new File(["# 研修問題"], "q.md", { type: "text/markdown" });
    Object.defineProperty(input, "files", { value: [file] });
    input.dispatchEvent(new Event("change"));
    await flush(3);

    document.getElementById("generate-button").click();
    await flush(3);

    const statusBox = document.getElementById("generate-status");
    expect(statusBox.className).toBe("ok");
    expect(statusBox.textContent).toContain("新教材");
    expect(statusBox.querySelector("button")).not.toBeNull();
  });

  it("生成APIがエラーを返した場合はng表示になる", async () => {
    setupFetchMock([
      {
        method: "POST",
        match: /\/api\/courses\/generate$/,
        handler: () => ({ body: { error: "生成失敗" } }),
      },
    ]);
    loadApp();
    await flush(2);

    const input = document.getElementById("md-file-input");
    const file = new File(["# 研修問題"], "q.md", { type: "text/markdown" });
    Object.defineProperty(input, "files", { value: [file] });
    input.dispatchEvent(new Event("change"));
    await flush(3);

    document.getElementById("generate-button").click();
    await flush(2);

    const statusBox = document.getElementById("generate-status");
    expect(statusBox.className).toBe("ng");
    expect(statusBox.textContent).toContain("生成失敗");
  });

  it("通信エラー時はng表示になる", async () => {
    setupFetchMock();
    loadApp();
    await flush(2);
    global.fetch = jest.fn(() => Promise.reject(new Error("network down")));

    const input = document.getElementById("md-file-input");
    const file = new File(["# 研修問題"], "q.md", { type: "text/markdown" });
    Object.defineProperty(input, "files", { value: [file] });
    input.dispatchEvent(new Event("change"));
    await flush(3);

    document.getElementById("generate-button").click();
    await flush(2);

    const statusBox = document.getElementById("generate-status");
    expect(statusBox.className).toBe("ng");
    expect(statusBox.textContent).toContain("通信エラー");
  });

  it("再生成モード: 開始/キャンセルで見出し表示が切り替わる", async () => {
    setupFetchMock([
      {
        method: "GET",
        match: /\/api\/courses$/,
        handler: () => ({ body: [{ id: "c1", title: "コース1", builtin: false }] }),
      },
    ]);
    loadApp();
    await flush(2);

    document.querySelectorAll(".course-card button")[1].click(); // 「この問題を再生成」
    expect(document.getElementById("upload-heading").textContent).toContain("再生成");
    expect(document.getElementById("cancel-regenerate-button").style.display).toBe("inline-block");

    document.getElementById("cancel-regenerate-button").click();
    expect(document.getElementById("upload-heading").textContent).toBe("新しい問題(.md)を読み込む");
    expect(document.getElementById("cancel-regenerate-button").style.display).toBe("none");
  });

  it("再生成モードでconfirmをキャンセルすると送信されない", async () => {
    const fetchMock = setupFetchMock([
      {
        method: "GET",
        match: /\/api\/courses$/,
        handler: () => ({ body: [{ id: "c1", title: "コース1", builtin: false }] }),
      },
    ]);
    loadApp();
    await flush(2);

    document.querySelectorAll(".course-card button")[1].click();
    const input = document.getElementById("md-file-input");
    const file = new File(["# 研修問題"], "q.md", { type: "text/markdown" });
    Object.defineProperty(input, "files", { value: [file] });
    input.dispatchEvent(new Event("change"));
    await flush(3);

    window.confirm.mockReturnValueOnce(false);
    document.getElementById("generate-button").click();
    await flush(2);

    expect(fetchMock).not.toHaveBeenCalledWith(expect.stringContaining("regenerate"), expect.anything());
  });
});

// ============================================================
// STEP進行・判定
// ============================================================
function buildStepCourseRoutes(criteria = ["基準A", "基準B"]) {
  return [
    { method: "GET", match: /\/api\/courses$/, handler: () => ({ body: [{ id: "c1", title: "コース1", builtin: false }] }) },
    {
      method: "GET",
      match: /\/api\/courses\/c1$/,
      handler: () => ({
        body: {
          title: "コース1",
          subtitle: "",
          steps: [
            { id: 1, title: "タスク1", goalHtml: "<p>g</p>", detailHtml: "<p>d</p>", checkpoint: { instruction: "i", criteria } },
            { id: 2, title: "タスク2", goalHtml: "<p>g2</p>", detailHtml: "<p>d2</p>", checkpoint: { instruction: "i2", criteria: ["c"] } },
          ],
        },
      }),
    },
    { method: "GET", match: /\/api\/progress\/c1$/, handler: () => ({ body: {} }) },
  ];
}

async function openCourse1() {
  loadApp();
  await flush(2);
  document.querySelector(".start-button").click();
  await flush(2);
}

describe("STEP進行画面", () => {
  it("次へ/前へボタンでSTEPを移動できる", async () => {
    setupFetchMock(buildStepCourseRoutes());
    await openCourse1();

    document.getElementById("next-button").click();
    expect(document.getElementById("step-title").textContent).toBe("タスク2");
    expect(document.getElementById("next-button").disabled).toBe(true);

    document.getElementById("prev-button").click();
    expect(document.getElementById("step-title").textContent).toBe("タスク1");
  });

  it("ナビゲーションボタンクリックでも該当STEPに移動する", async () => {
    setupFetchMock(buildStepCourseRoutes());
    await openCourse1();

    document.querySelectorAll("#step-nav button")[1].click();
    expect(document.getElementById("step-title").textContent).toBe("タスク2");
  });

  it("戻るボタンでライブラリ画面に戻る", async () => {
    setupFetchMock(buildStepCourseRoutes());
    await openCourse1();

    document.getElementById("back-to-library-button").click();
    await flush(2);

    expect(document.getElementById("library-screen").style.display).toBe("flex");
    expect(document.getElementById("course-screen").style.display).toBe("none");
  });

  it("ファイルを選択するとプレビューに表示され、削除ボタンで取り除ける", async () => {
    setupFetchMock(buildStepCourseRoutes());
    await openCourse1();

    const input = document.getElementById("screenshot-input");
    const file = new File(["img"], "shot.png", { type: "image/png" });
    Object.defineProperty(input, "files", { value: [file] });
    input.dispatchEvent(new Event("change"));

    expect(document.querySelectorAll("#preview .thumb")).toHaveLength(1);

    document.querySelector(".thumb-remove").click();
    expect(document.querySelectorAll("#preview .thumb")).toHaveLength(0);
  });

  it("クリップボードからの画像貼り付けでプレビューに追加される", async () => {
    setupFetchMock(buildStepCourseRoutes());
    await openCourse1();

    const file = new File(["img"], "pasted.png", { type: "image/png" });
    const pasteEvent = new Event("paste", { bubbles: true, cancelable: true });
    pasteEvent.clipboardData = { items: [{ type: "image/png", getAsFile: () => file }] };
    document.getElementById("paste-area").dispatchEvent(pasteEvent);

    expect(document.querySelectorAll("#preview .thumb")).toHaveLength(1);
  });

  it("テキストの貼り付けは無視される", async () => {
    setupFetchMock(buildStepCourseRoutes());
    await openCourse1();

    const pasteEvent = new Event("paste", { bubbles: true, cancelable: true });
    pasteEvent.clipboardData = { items: [{ type: "text/plain", getAsFile: () => null }] };
    document.getElementById("paste-area").dispatchEvent(pasteEvent);

    expect(document.querySelectorAll("#preview .thumb")).toHaveLength(0);
  });

  it("ファイル未選択で判定ボタンを押すとエラー表示", async () => {
    setupFetchMock(buildStepCourseRoutes());
    await openCourse1();

    document.getElementById("judge-button").click();
    await flush(1);

    expect(document.getElementById("judge-result").className).toBe("ng");
    expect(document.getElementById("judge-result").textContent).toContain("スクリーンショットを選択してください");
  });

  it("全項目すでに合格済みの場合はAPIを呼ばずに合格済み表示", async () => {
    const routes = buildStepCourseRoutes(["基準A"]);
    routes[2] = { method: "GET", match: /\/api\/progress\/c1$/, handler: () => ({ body: { 1: [true] } }) };
    const fetchMock = setupFetchMock(routes);
    await openCourse1();

    document.getElementById("judge-button").click();
    await flush(1);

    expect(document.getElementById("judge-result").textContent).toContain("すべて合格済み");
    expect(fetchMock).not.toHaveBeenCalledWith("/api/judge", expect.anything());
  });

  it("判定APIが一部合格を返した場合は一部未合格表示になり進捗が保存される", async () => {
    const fetchMock = setupFetchMock([
      ...buildStepCourseRoutes(["基準A", "基準B"]),
      {
        method: "POST",
        match: /\/api\/judge$/,
        handler: () => ({
          body: {
            judgement: "NG",
            reason: "一部足りません",
            checks: [
              { index: 0, item: "基準A", passed: true },
              { index: 1, item: "基準B", passed: false },
            ],
          },
        }),
      },
      { method: "POST", match: /\/api\/progress$/, handler: () => ({ body: { ok: true } }) },
    ]);
    await openCourse1();

    const input = document.getElementById("screenshot-input");
    const file = new File(["img"], "shot.png", { type: "image/png" });
    Object.defineProperty(input, "files", { value: [file] });
    input.dispatchEvent(new Event("change"));

    document.getElementById("judge-button").click();
    await flush(3);

    const resultBox = document.getElementById("judge-result");
    expect(resultBox.className).toBe("unknown");
    expect(resultBox.textContent).toContain("一部未合格");
    expect(resultBox.textContent).toContain("一部足りません");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/progress",
      expect.objectContaining({ method: "POST" })
    );
    // 選択中ファイルは判定後にクリアされる
    expect(document.querySelectorAll("#preview .thumb")).toHaveLength(0);
  });

  it("判定APIが全合格を返した場合は合格表示になりnavにpassedが付く", async () => {
    setupFetchMock([
      ...buildStepCourseRoutes(["基準A"]),
      {
        method: "POST",
        match: /\/api\/judge$/,
        handler: () => ({
          body: { judgement: "OK", reason: "OK", checks: [{ index: 0, item: "基準A", passed: true }] },
        }),
      },
      { method: "POST", match: /\/api\/progress$/, handler: () => ({ body: { ok: true } }) },
    ]);
    await openCourse1();

    const input = document.getElementById("screenshot-input");
    const file = new File(["img"], "shot.png", { type: "image/png" });
    Object.defineProperty(input, "files", { value: [file] });
    input.dispatchEvent(new Event("change"));

    document.getElementById("judge-button").click();
    await flush(3);

    expect(document.getElementById("judge-result").className).toBe("ok");
    expect(document.querySelector("#step-nav button").classList.contains("passed")).toBe(true);
  });

  it("判定APIがエラーを返した場合はエラー表示になる", async () => {
    setupFetchMock([
      ...buildStepCourseRoutes(["基準A"]),
      { method: "POST", match: /\/api\/judge$/, handler: () => ({ body: { error: "判定失敗" } }) },
    ]);
    await openCourse1();

    const input = document.getElementById("screenshot-input");
    const file = new File(["img"], "shot.png", { type: "image/png" });
    Object.defineProperty(input, "files", { value: [file] });
    input.dispatchEvent(new Event("change"));

    document.getElementById("judge-button").click();
    await flush(2);

    const resultBox = document.getElementById("judge-result");
    expect(resultBox.className).toBe("ng");
    expect(resultBox.textContent).toContain("判定失敗");
  });

  it("進捗保存(persistProgress)が失敗してもUIはブロックされない", async () => {
    const consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    setupFetchMock([
      ...buildStepCourseRoutes(["基準A"]),
      {
        method: "POST",
        match: /\/api\/judge$/,
        handler: () => ({
          body: { judgement: "OK", reason: "OK", checks: [{ index: 0, item: "基準A", passed: true }] },
        }),
      },
    ]);
    await openCourse1();

    const originalFetch = global.fetch;
    global.fetch = jest.fn((url, opts) => {
      if (url === "/api/progress") return Promise.reject(new Error("progress保存失敗"));
      return originalFetch(url, opts);
    });

    const input = document.getElementById("screenshot-input");
    const file = new File(["img"], "shot.png", { type: "image/png" });
    Object.defineProperty(input, "files", { value: [file] });
    input.dispatchEvent(new Event("change"));

    document.getElementById("judge-button").click();
    await flush(3);

    expect(document.getElementById("judge-result").className).toBe("ok");
    expect(consoleErrorSpy).toHaveBeenCalledWith("進捗の保存に失敗しました", expect.any(Error));
  });

  it("判定中の通信エラーはエラー表示になり、ボタンが再度有効になる", async () => {
    setupFetchMock(buildStepCourseRoutes(["基準A"]));
    await openCourse1();

    const input = document.getElementById("screenshot-input");
    const file = new File(["img"], "shot.png", { type: "image/png" });
    Object.defineProperty(input, "files", { value: [file] });
    input.dispatchEvent(new Event("change"));

    const originalFetch = global.fetch;
    global.fetch = jest.fn((url, opts) => {
      if (url === "/api/judge") return Promise.reject(new Error("通信失敗"));
      return originalFetch(url, opts);
    });

    document.getElementById("judge-button").click();
    await flush(2);

    const resultBox = document.getElementById("judge-result");
    expect(resultBox.className).toBe("ng");
    expect(resultBox.textContent).toContain("通信失敗");
    expect(document.getElementById("judge-button").disabled).toBe(false);
  });
});
