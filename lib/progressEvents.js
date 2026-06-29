// ============================================================
// コース生成の進捗通知（SSE: Server-Sent Events）
//
// generate/regenerateの本処理（POST、JSONレスポンス）はそのままに、jobIdをキーにした
// 別チャンネル（GET、EventSource）で「mdの読み込み/問題作成/json出力」の完了通知だけを流す。
// 本処理の入出力契約を変えずに済むよう、進捗通知はjobId未指定なら何もしないだけの副作用にしている。
//
// POST(本処理)とGET(SSE接続)は別リクエストのため、SSEが繋がるより先にPOST側の最初の
// 進捗通知(md_loaded)が発生する競合状態が起こりうる（実際に発生し、最初の段階の表示が
// 抜け落ちる不具合になった）。これを防ぐため、stageは送信のたびにhistoryへも積んでおき、
// GET接続時にこれまでの分を即時リプレイすることで、接続タイミングに関わらず全段階を表示できるようにする。
// ============================================================

const progressJobs = new Map(); // jobId -> { clients: Set<res>, history: string[] }

function getOrCreateProgressJob(jobId) {
  if (!progressJobs.has(jobId)) progressJobs.set(jobId, { clients: new Set(), history: [] });
  return progressJobs.get(jobId);
}

function sendProgress(jobId, stage) {
  if (!jobId) return;
  const job = getOrCreateProgressJob(jobId);
  job.history.push(stage);
  const payload = `data: ${JSON.stringify({ stage })}\n\n`;
  for (const res of job.clients) res.write(payload);
}

/** 生成処理の完了後、該当jobIdのSSE接続を全て閉じてMapから片付ける */
function closeProgress(jobId) {
  if (!jobId) return;
  const job = progressJobs.get(jobId);
  if (!job) return;
  for (const res of job.clients) res.end();
  progressJobs.delete(jobId);
}

module.exports = {
  getOrCreateProgressJob,
  sendProgress,
  closeProgress,
};
