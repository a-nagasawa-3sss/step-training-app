// ============================================================
// データ保存（コース・進捗）の読み書き
//
// すべてファイルベース（DB不使用）：
//   data/steps.json          組み込みコース"aws-level1-default"の教材本体
//   data/courses/index.json  生成済みコースの一覧（メタ情報のみ）
//   data/courses/<id>.json   生成済みコースの教材本体（1ファイル1コース）
//   data/progress.json       コースごとの判定基準チェック状態（永続化）
//
// ※スケール時の注意：
//   現状はローカルディスク上のJSONファイルを直接読み書きしているため、
//   サーバーを複数台・複数プロセスに増やすとデータが共有されず不整合が起きる。
//   外部サービス化する際は、このDATA_DIR配下のファイルI/Oを
//   DB（RDS等）やオブジェクトストレージ（S3等）に置き換える必要がある。
//   また loadXxx/saveXxx は排他制御（ロック）をしていないため、
//   同時アクセスがあるとファイルの書き込みが競合（後勝ちで上書き）するリスクがある。
// ============================================================

const path = require("path");
const fs = require("fs");

// STEP_TRAINING_DATA_DIRが設定されている場合はそちらを使う（結合テストで実データを汚さないための切り替え用）
const DATA_DIR = process.env.STEP_TRAINING_DATA_DIR || path.join(__dirname, "..", "data");
const COURSES_DIR = path.join(DATA_DIR, "courses");
const COURSE_INDEX_PATH = path.join(COURSES_DIR, "index.json");
const PROGRESS_PATH = path.join(DATA_DIR, "progress.json");
// 手作業で作成した最初の教材は、生成コースと区別するための特別なID("builtin")として扱う
const DEFAULT_COURSE_ID = "aws-level1-default";
const DEFAULT_COURSE_PATH = path.join(DATA_DIR, "steps.json");

/**
 * 生成済みコースの一覧（id/title/sourceFilenameなどのメタ情報）を読み込む。
 * ファイルが無い・壊れている場合は空配列として扱う（初回起動時など）。
 */
function loadCourseIndex() {
  try {
    return JSON.parse(fs.readFileSync(COURSE_INDEX_PATH, "utf-8"));
  } catch {
    return [];
  }
}

function saveCourseIndex(index) {
  fs.writeFileSync(COURSE_INDEX_PATH, JSON.stringify(index, null, 2));
}

/**
 * コースIDから実際の教材JSONファイルのパスを求める。
 * 組み込みコースだけは data/steps.json という別の固定ファイルを指す
 * （生成コースと同じ data/courses/ に置かず、手作業の教材を上書きされないように分離している）。
 */
function courseFilePath(id) {
  return id === DEFAULT_COURSE_ID
    ? DEFAULT_COURSE_PATH
    : path.join(COURSES_DIR, `${id}.json`);
}

/** コースの教材本体（title/subtitle/steps）を読み込む。存在しなければnull。 */
function loadCourse(id) {
  try {
    return JSON.parse(fs.readFileSync(courseFilePath(id), "utf-8"));
  } catch {
    return null;
  }
}

function saveCourse(id, course) {
  fs.writeFileSync(courseFilePath(id), JSON.stringify(course, null, 2));
}

// ------------------------------------------------------------
// 受講生の進捗（判定基準ごとのチェック状態）
//
// 保存形式: { [courseId]: { [stepId]: [true, false, ...] } }
// 配列のインデックスは、そのstepのcheckpoint.criteriaの並び順に対応する。
// ------------------------------------------------------------

/**
 * 進捗データを読み込む。
 * 旧バージョン（コース単位の名前空間が無く、{stepId: [...]}のみのフラットな形式）が
 * 残っている場合は、組み込みコース扱いとして自動的に移行し、新形式で書き戻す。
 */
function loadProgress() {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(PROGRESS_PATH, "utf-8"));
  } catch {
    return {};
  }
  // 値がそのまま配列（[true, false, ...]）になっていれば旧フラット形式と判断する
  const isOldFlatFormat = Object.values(raw).some((v) => Array.isArray(v));
  if (isOldFlatFormat) {
    const migrated = { [DEFAULT_COURSE_ID]: raw };
    saveProgress(migrated);
    return migrated;
  }
  return raw;
}

function saveProgress(progress) {
  fs.writeFileSync(PROGRESS_PATH, JSON.stringify(progress, null, 2));
}

module.exports = {
  DATA_DIR,
  COURSES_DIR,
  COURSE_INDEX_PATH,
  PROGRESS_PATH,
  DEFAULT_COURSE_ID,
  DEFAULT_COURSE_PATH,
  loadCourseIndex,
  saveCourseIndex,
  courseFilePath,
  loadCourse,
  saveCourse,
  loadProgress,
  saveProgress,
};
