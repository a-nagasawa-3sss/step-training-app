// ============================================================
// AI判定（アップロードされたスクリーンショットの合否判定）
//
// 未合格の判定基準だけを対象に、選択中のプロバイダーへプロンプト＋画像を送って
// 合否判定させる処理をまとめている。server.jsの /api/judge エンドポイントは
// リクエストの検証とレスポンス整形だけを担い、判定ロジック本体はここに切り出す。
// ============================================================

const { anthropic, CLAUDE_MODEL, openai, OPENAI_MODEL, genAI, GEMINI_MODEL, withRetry } = require("./aiProviders");
const { extractJson } = require("./jsonExtract");

/** 判定用に、選択中のプロバイダーへプロンプト＋スクリーンショットを送ってテキスト応答を取得する */
async function getJudgeResponseText(provider, prompt, files) {
  if (provider === "claude") {
    const message = await withRetry(() =>
      anthropic.messages.create({
        model: CLAUDE_MODEL,
        max_tokens: 2048,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: prompt },
              ...files.map((file) => ({
                type: "image",
                source: { type: "base64", media_type: file.mimetype, data: file.buffer.toString("base64") },
              })),
            ],
          },
        ],
      })
    );
    return message.content.map((block) => block.text || "").join("").trim();
  }
  if (provider === "openai") {
    const completion = await withRetry(() =>
      openai.chat.completions.create({
        model: OPENAI_MODEL,
        max_completion_tokens: 2048,
        reasoning_effort: "minimal",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: prompt },
              ...files.map((file) => ({
                type: "image_url",
                image_url: { url: `data:${file.mimetype};base64,${file.buffer.toString("base64")}` },
              })),
            ],
          },
        ],
      })
    );
    return (completion.choices[0].message.content || "").trim();
  }
  const model = genAI.getGenerativeModel({ model: GEMINI_MODEL });
  const imageParts = files.map((file) => ({
    inlineData: { mimeType: file.mimetype, data: file.buffer.toString("base64") },
  }));
  const result = await withRetry(() => model.generateContent([prompt, ...imageParts]));
  return result.response.text().trim();
}

/**
 * criteriaIndicesRaw（フロントエンドがまだチェックの入っていない判定基準だけを送ってくる、
 * JSON文字列化されたインデックス配列）から、今回判定すべきインデックス一覧を求める。
 * 指定が無い/不正な場合は全項目を対象にする。
 */
function resolveTargetIndices(allCriteria, criteriaIndicesRaw) {
  try {
    const requested = JSON.parse(criteriaIndicesRaw || "[]");
    if (Array.isArray(requested) && requested.length) {
      return requested.filter((i) => Number.isInteger(i) && i >= 0 && i < allCriteria.length);
    }
  } catch {
    // 指定がない/不正な場合は全項目を対象にする
  }
  return allCriteria.map((_, i) => i);
}

/**
 * 1ステップ分のスクリーンショットをAIに判定させ、{judgement, reason, checks} を返す。
 * 判定基準には元のインデックス番号を振っておき、AIの出力にも同じindexを
 * 引き継がせることで、レスポンスとフロントエンドの状態（どの項目が何番目か）を正しく対応付ける。
 */
async function judgeScreenshots(step, files, provider, criteriaIndicesRaw) {
  const allCriteria = step.checkpoint.criteria;
  const targetIndices = resolveTargetIndices(allCriteria, criteriaIndicesRaw);
  if (targetIndices.length === 0) {
    return { judgement: "OK", reason: "判定対象の項目がありません（すべて判定済みです）。", checks: [] };
  }

  const criteriaText = targetIndices.map((i) => `${i}. ${allCriteria[i]}`).join("\n");
  const prompt = [
    "あなたはIT技術研修の採点担当者です。受講生がこのアプリを使い実装や構築を行った実装コードやコンソール画面などのスクリーンショット（複数枚の場合は全体を合わせて1つの提出物として）を見て、",
    "以下の判定基準を1項目ずつ満たしているかどうかを判定してください。",
    "",
    `# タスク: ${step.title}`,
    "",
    "# 判定基準（先頭の数字はインデックス番号、必ずそのまま出力に使うこと）",
    criteriaText,
    "",
    "# 出力形式",
    "次のJSON形式のみで出力してください。説明文やコードブロック記号は付けないこと。",
    "checksには上記の判定基準を1つずつ、indexの値はそのまま引き継いで、全項目分を出力すること。",
    "不合格項目についてはタスククリアのために必要な情報や解決ヒントを含めること。",
    '{"reason": "全体の判定理由を日本語で2〜4文", "checks": [{"index": 0, "item": "判定基準の項目", "passed": true または false}]}',
  ].join("\n");

  const text = await getJudgeResponseText(provider, prompt, files);
  let parsed;
  try {
    parsed = extractJson(text);
  } catch {
    // JSONとして解釈できない場合でも、原文をreasonとして返し、判定不能(NG扱い)として処理を継続する
    parsed = { reason: text, checks: [] };
  }

  // AIが返したchecks配列をindexで引けるようにしておく
  const checksByIndex = new Map();
  if (Array.isArray(parsed.checks)) {
    parsed.checks.forEach((c) => {
      if (Number.isInteger(c.index)) checksByIndex.set(c.index, c);
    });
  }
  // 依頼した項目(targetIndices)を基準にレスポンスを組み立てる。
  // AIが一部の項目について回答を返し忘れた場合も、ここでpassed: falseとして補完される
  const checks = targetIndices.map((i) => {
    const found = checksByIndex.get(i);
    return {
      index: i,
      item: allCriteria[i],
      passed: Boolean(found && found.passed),
    };
  });
  const judgement = checks.every((c) => c.passed) ? "OK" : "NG";

  return { judgement, reason: parsed.reason || "", checks };
}

module.exports = {
  getJudgeResponseText,
  judgeScreenshots,
};
