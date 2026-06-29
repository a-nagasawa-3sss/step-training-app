// lib/progressEvents.js の単体試験。
// SSE接続(res)はwrite/endを記録するだけのダミーオブジェクトで代用し、
// jobId単位の進捗履歴・配信・後始末ロジックを直接検証する。
const { getOrCreateProgressJob, sendProgress, closeProgress } = require("../../lib/progressEvents");

function fakeRes() {
  return { write: jest.fn(), end: jest.fn() };
}

describe("getOrCreateProgressJob", () => {
  it("同じjobIdなら同一のjobオブジェクトを返す", () => {
    const job1 = getOrCreateProgressJob("job-1");
    const job2 = getOrCreateProgressJob("job-1");
    expect(job1).toBe(job2);
  });

  it("初回は空のclients/historyを持つ", () => {
    const job = getOrCreateProgressJob("job-fresh");
    expect(job.clients.size).toBe(0);
    expect(job.history).toEqual([]);
  });
});

describe("sendProgress", () => {
  it("jobId未指定の場合は何もしない", () => {
    expect(() => sendProgress(undefined, "md_loaded")).not.toThrow();
  });

  it("historyに段階を積み、接続中のclientへ配信する", () => {
    const job = getOrCreateProgressJob("job-send");
    const res = fakeRes();
    job.clients.add(res);

    sendProgress("job-send", "md_loaded");

    expect(job.history).toEqual(["md_loaded"]);
    expect(res.write).toHaveBeenCalledWith(`data: ${JSON.stringify({ stage: "md_loaded" })}\n\n`);
  });

  it("複数回送ると履歴が積み重なる", () => {
    getOrCreateProgressJob("job-multi");
    sendProgress("job-multi", "md_loaded");
    sendProgress("job-multi", "ai_generated");
    expect(getOrCreateProgressJob("job-multi").history).toEqual(["md_loaded", "ai_generated"]);
  });
});

describe("closeProgress", () => {
  it("jobId未指定の場合は何もしない", () => {
    expect(() => closeProgress(undefined)).not.toThrow();
  });

  it("存在しないjobIdの場合は何もしない", () => {
    expect(() => closeProgress("not-exist")).not.toThrow();
  });

  it("接続中の全clientをendし、Mapから削除する", () => {
    const job = getOrCreateProgressJob("job-close");
    const res1 = fakeRes();
    const res2 = fakeRes();
    job.clients.add(res1);
    job.clients.add(res2);

    closeProgress("job-close");

    expect(res1.end).toHaveBeenCalledTimes(1);
    expect(res2.end).toHaveBeenCalledTimes(1);
    // 削除されたため、再取得すると新規のjobになる(historyが空に戻る)
    expect(getOrCreateProgressJob("job-close").history).toEqual([]);
  });
});
