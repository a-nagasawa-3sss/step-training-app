// ============================================================
// AI応答テキストからのJSON抽出
//
// 「JSONのみを返して」と指示してもコードブロック記号が混ざったり、
// 文字列内の制御文字・ダブルクオートの扱いが崩れたりすることがあるため、
// それらを吸収して安全にJSON.parseするための処理をまとめている。
// ============================================================

/**
 * JSON文字列リテラル内に生の制御文字（改行・タブ等）が混在していても解釈できるよう、
 * 文字列内だけを対象に \n \t 等へエスケープし直す。
 * コードブロックを含む長文を生成させると、AIが「改行を保持したまま転記して」という
 * 指示を素直に解釈しすぎて、JSON的には本来 \n とすべき箇所に生の改行文字を出力してしまい、
 * JSON.parseが「Bad control character in string literal」で失敗するケースがあるための対策。
 */
function escapeControlCharsInJsonStrings(text) {
  let result = "";
  let inString = false;
  let escapeNext = false;
  for (const ch of text) {
    if (!inString) {
      if (ch === '"') inString = true;
      result += ch;
      continue;
    }
    if (escapeNext) {
      result += ch;
      escapeNext = false;
      continue;
    }
    if (ch === "\\") {
      result += ch;
      escapeNext = true;
      continue;
    }
    if (ch === '"') {
      inString = false;
      result += ch;
      continue;
    }
    const code = ch.codePointAt(0);
    if (code === 0x0a) result += "\\n";
    else if (code === 0x0d) result += "\\r";
    else if (code === 0x09) result += "\\t";
    else if (code < 0x20) result += "\\u" + code.toString(16).padStart(4, "0");
    else result += ch;
  }
  return result;
}

/**
 * 通常のJSON.parseが失敗した場合の最終手段として使う、バックトラック式の寛容なJSONパーサー。
 *
 * Geminiは、問題.md中に元々ある `{"product_id": id, "quantity": 0}` のようなコード片を
 * detailHtml等のテキストに転記する際、内部のダブルクオートをエスケープせずそのまま出力することがある
 * （Claude/OpenAIは正しくエスケープするため発生しない、Gemini固有の癖）。
 * プロンプトで強くエスケープを指示しても改善しなかったため、出力側で吸収する。
 *
 * 文字列リテラルの終端となる `"` は本来一意に決まるはずだが、上記のように内部に
 * 生の `"` が混ざると複数の終端候補ができてしまう。そこで候補ごとに「その位置で文字列を
 * 閉じたとして残りが正しくJSONとして解釈できるか」を再帰的に検証し、成功する候補が
 * 見つかるまで候補をひとつずつ試す（失敗したら一つ手前の候補にバックトラックする）。
 */
function tolerantJsonParse(text) {
  const FAIL = Symbol("FAIL");
  const MAX_ATTEMPTS = 200000;
  let attemptCount = 0;

  function skipWs(p) {
    while (p < text.length && /\s/.test(text[p])) p++;
    return p;
  }

  // start以降にある「エスケープされていない（＝文字列の終端候補になりうる）」`"` の位置を列挙する
  function findUnescapedQuotes(start) {
    const positions = [];
    let escaped = false;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (c === "\\") {
        escaped = true;
        continue;
      }
      if (c === '"') positions.push(i);
    }
    return positions;
  }

  function parseString(p, k) {
    if (text[p] !== '"') return FAIL;
    const start = p + 1;
    const quotePositions = findUnescapedQuotes(start);
    for (let i = 0; i < quotePositions.length; i++) {
      if (++attemptCount > MAX_ATTEMPTS) throw new Error("バックトラック回数が上限を超えました");
      const end = quotePositions[i];
      // candidates[0..i-1]は今回の候補では文字列の中身として扱うため、\" にエスケープし直す
      let content = "";
      let prev = start;
      for (let j = 0; j < i; j++) {
        content += text.slice(prev, quotePositions[j]) + '\\"';
        prev = quotePositions[j] + 1;
      }
      content += text.slice(prev, end);
      let decoded;
      try {
        decoded = JSON.parse('"' + content + '"');
      } catch {
        continue;
      }
      const result = k(decoded, end + 1);
      if (result !== FAIL) return result;
    }
    return FAIL;
  }

  function parseObjectMembers(p, obj, first, k) {
    p = skipWs(p);
    if (text[p] === "}") return k(obj, p + 1);
    if (!first) {
      if (text[p] !== ",") return FAIL;
      p = skipWs(p + 1);
      if (text[p] === "}") return k(obj, p + 1);
    }
    return parseString(p, (key, p2) => {
      p2 = skipWs(p2);
      if (text[p2] !== ":") return FAIL;
      p2 = skipWs(p2 + 1);
      return parseValue(p2, (val, p3) => parseObjectMembers(p3, { ...obj, [key]: val }, false, k));
    });
  }

  function parseArrayMembers(p, arr, first, k) {
    p = skipWs(p);
    if (text[p] === "]") return k(arr, p + 1);
    if (!first) {
      if (text[p] !== ",") return FAIL;
      p = skipWs(p + 1);
      if (text[p] === "]") return k(arr, p + 1);
    }
    return parseValue(p, (val, p2) => parseArrayMembers(p2, [...arr, val], false, k));
  }

  function parseValue(p, k) {
    p = skipWs(p);
    if (p >= text.length) return FAIL;
    const c = text[p];
    if (c === '"') return parseString(p, k);
    if (c === "{") return parseObjectMembers(p + 1, {}, true, k);
    if (c === "[") return parseArrayMembers(p + 1, [], true, k);
    if (text.startsWith("true", p)) return k(true, p + 4);
    if (text.startsWith("false", p)) return k(false, p + 5);
    if (text.startsWith("null", p)) return k(null, p + 4);
    if (c === "-" || (c >= "0" && c <= "9")) {
      const m = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(text.slice(p));
      if (!m) return FAIL;
      return k(Number(m[0]), p + m[0].length);
    }
    return FAIL;
  }

  const result = parseValue(0, (val, pEnd) => {
    pEnd = skipWs(pEnd);
    if (pEnd !== text.length) return FAIL;
    return val;
  });
  if (result === FAIL) throw new Error("寛容モードでもJSONとして解釈できませんでした");
  return result;
}

/**
 * AIの応答テキストからJSONを取り出す。
 * 「JSONのみを返して」と指示しても ```json ... ``` のコードブロックで
 * 返してくることがあるため、その記号を取り除いてからparseする。
 *
 * 通常のJSON.parseが失敗した場合（主にGeminiがコード片中のダブルクオートを
 * エスケープせず出力してしまうケース）は、tolerantJsonParseでの救済を試みる。
 */
function extractJson(text) {
  const cleaned = text.trim().replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```$/, "").trim();
  const escaped = escapeControlCharsInJsonStrings(cleaned);
  try {
    return JSON.parse(escaped);
  } catch (err) {
    try {
      return tolerantJsonParse(escaped);
    } catch {
      throw err;
    }
  }
}

module.exports = {
  escapeControlCharsInJsonStrings,
  tolerantJsonParse,
  extractJson,
};
