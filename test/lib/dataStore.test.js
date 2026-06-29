// lib/dataStore.js の単体試験。
// fsはtest/mocks/fsMockでモック化し、実データ(data/配下)を汚さずに
// コース・進捗データの読み書きロジックだけを直接検証する。
jest.mock("fs", () => require("../mocks/fsMock"));

const path = require("path");
const fsMock = require("../mocks/fsMock");
const dataStore = require("../../lib/dataStore");

const { DATA_DIR, COURSE_INDEX_PATH, PROGRESS_PATH, DEFAULT_COURSE_ID, DEFAULT_COURSE_PATH } = dataStore;
const COURSES_DIR = path.join(DATA_DIR, "courses");

function courseFilePath(id) {
  return path.join(COURSES_DIR, `${id}.json`);
}

beforeEach(() => {
  fsMock.__store.clear();
});

describe("loadCourseIndex / saveCourseIndex", () => {
  it("ファイルが無い場合は空配列を返す", () => {
    expect(dataStore.loadCourseIndex()).toEqual([]);
  });

  it("壊れたJSONの場合も空配列を返す", () => {
    fsMock.__store.set(COURSE_INDEX_PATH, "{不正なJSON");
    expect(dataStore.loadCourseIndex()).toEqual([]);
  });

  it("保存した一覧を読み込める", () => {
    const index = [{ id: "abc", title: "T" }];
    dataStore.saveCourseIndex(index);
    expect(JSON.parse(fsMock.__store.get(COURSE_INDEX_PATH))).toEqual(index);
    expect(dataStore.loadCourseIndex()).toEqual(index);
  });
});

describe("courseFilePath", () => {
  it("組み込みコースIDはsteps.jsonを指す", () => {
    expect(dataStore.courseFilePath(DEFAULT_COURSE_ID)).toBe(DEFAULT_COURSE_PATH);
  });

  it("それ以外のIDはcourses/<id>.jsonを指す", () => {
    expect(dataStore.courseFilePath("abc")).toBe(courseFilePath("abc"));
  });
});

describe("loadCourse / saveCourse", () => {
  it("存在しないコースはnullを返す", () => {
    expect(dataStore.loadCourse("unknown")).toBeNull();
  });

  it("保存した教材本体を読み込める", () => {
    const course = { title: "T", subtitle: "S", steps: [] };
    dataStore.saveCourse("abc", course);
    expect(JSON.parse(fsMock.__store.get(courseFilePath("abc")))).toEqual(course);
    expect(dataStore.loadCourse("abc")).toEqual(course);
  });

  it("組み込みコースはsteps.jsonに保存・読込する", () => {
    const course = { title: "組み込み", subtitle: "", steps: [] };
    dataStore.saveCourse(DEFAULT_COURSE_ID, course);
    expect(fsMock.__store.has(DEFAULT_COURSE_PATH)).toBe(true);
    expect(dataStore.loadCourse(DEFAULT_COURSE_ID)).toEqual(course);
  });
});

describe("loadProgress / saveProgress", () => {
  it("ファイルが無い場合は空オブジェクトを返す", () => {
    expect(dataStore.loadProgress()).toEqual({});
  });

  it("新形式（コースIDの名前空間あり）はそのまま読み込める", () => {
    const progress = { abc: { 1: [true, false] } };
    dataStore.saveProgress(progress);
    expect(dataStore.loadProgress()).toEqual(progress);
  });

  it("旧フラット形式は組み込みコース扱いに自動移行し、新形式で書き戻す", () => {
    fsMock.__store.set(PROGRESS_PATH, JSON.stringify({ 1: [true, false] }));
    const migrated = dataStore.loadProgress();
    expect(migrated).toEqual({ [DEFAULT_COURSE_ID]: { 1: [true, false] } });
    expect(JSON.parse(fsMock.__store.get(PROGRESS_PATH))).toEqual(migrated);
  });
});
