// fsモジュールのテスト用モック。
// data/配下のパスだけをメモリ上のMapで差し替え、それ以外(express/multer内部が使うfs呼び出し等)は
// 実際のfsにそのまま委譲する。これにより、実データを汚さずにserver.jsの永続化処理だけを検証できる。
const path = require("path");

const actualFs = jest.requireActual("fs");
const DATA_DIR = path.join(__dirname, "..", "..", "data");

const store = new Map();

function isManaged(targetPath) {
  return typeof targetPath === "string" && path.resolve(targetPath).startsWith(path.resolve(DATA_DIR));
}

function enoent(action, targetPath) {
  const err = new Error(`ENOENT: no such file or directory, ${action} '${targetPath}'`);
  err.code = "ENOENT";
  return err;
}

const fsMock = {
  ...actualFs,
  __store: store,
  __DATA_DIR: DATA_DIR,
  readFileSync: jest.fn((targetPath, ...args) => {
    if (isManaged(targetPath)) {
      if (store.has(targetPath)) return store.get(targetPath);
      throw enoent("open", targetPath);
    }
    return actualFs.readFileSync(targetPath, ...args);
  }),
  writeFileSync: jest.fn((targetPath, data, ...args) => {
    if (isManaged(targetPath)) {
      store.set(targetPath, data);
      return;
    }
    return actualFs.writeFileSync(targetPath, data, ...args);
  }),
  unlinkSync: jest.fn((targetPath) => {
    if (isManaged(targetPath)) {
      if (!store.has(targetPath)) throw enoent("unlink", targetPath);
      store.delete(targetPath);
      return;
    }
    return actualFs.unlinkSync(targetPath);
  }),
};

module.exports = fsMock;
