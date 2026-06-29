// lib/jsonExtract.js の単体試験。
// AI応答テキストからのJSON抽出（コードブロック除去・制御文字エスケープ・寛容パース）を、
// HTTP層を経由せず関数単位で直接検証する。
const { escapeControlCharsInJsonStrings, tolerantJsonParse, extractJson } = require("../../lib/jsonExtract");

describe("escapeControlCharsInJsonStrings", () => {
  it("文字列リテラルの外側の改行は変化させない", () => {
    const text = '{\n  "a": "b"\n}';
    expect(escapeControlCharsInJsonStrings(text)).toBe(text);
  });

  it("文字列リテラル内の生の改行・タブ・復帰をエスケープする", () => {
    const text = '"line1\nline2\tend\r"';
    expect(escapeControlCharsInJsonStrings(text)).toBe('"line1\\nline2\\tend\\r"');
  });

  it("バックスラッシュエスケープされた文字はそのまま通す（エスケープ済みの\"は文字列終端と誤認しない）", () => {
    const text = '"a\\"b\nc"';
    expect(escapeControlCharsInJsonStrings(text)).toBe('"a\\"b\\nc"');
  });
});

describe("tolerantJsonParse", () => {
  it("通常の有効なJSONをパースできる", () => {
    expect(tolerantJsonParse('{"a":1,"b":[true,false,null],"c":"x"}')).toEqual({
      a: 1,
      b: [true, false, null],
      c: "x",
    });
  });

  it("文字列中に生のダブルクオートが混在していてもバックトラックで解釈できる", () => {
    // Geminiがコード片中のダブルクオートをエスケープせず出力するケースを想定
    const broken = '{"a":"say "hi" now"}';
    expect(tolerantJsonParse(broken)).toEqual({ a: 'say "hi" now' });
  });

  it("候補の文字列が不正なエスケープ(\\u12のような不完全なユニコードエスケープ)で解釈に失敗する場合は次の候補にバックトラックする", () => {
    const broken = '{"a":"\\u12"x"}';
    expect(() => tolerantJsonParse(broken)).toThrow("寛容モードでもJSONとして解釈できませんでした");
  });

  it("解釈できない入力はエラーを投げる", () => {
    expect(() => tolerantJsonParse("これはJSONではありません")).toThrow(
      "寛容モードでもJSONとして解釈できませんでした"
    );
  });

  it("末尾に余分な文字があるとエラーを投げる", () => {
    expect(() => tolerantJsonParse('{"a":1} 余分')).toThrow();
  });
});

describe("extractJson", () => {
  it("プレーンなJSON文字列をパースできる", () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });

  it("```json フェンス付きの応答からJSONを取り出せる", () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it("言語指定なしの``` フェンスからもJSONを取り出せる", () => {
    expect(extractJson('```\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it("文字列内に生の改行が混在していても解釈できる", () => {
    const broken = '{"detailHtml":"line1\nline2"}';
    expect(extractJson(broken)).toEqual({ detailHtml: "line1\nline2" });
  });

  it("通常のJSON.parseが失敗した場合はtolerantJsonParseで救済する", () => {
    const broken = '{"a":"say "hi" now"}';
    expect(extractJson(broken)).toEqual({ a: 'say "hi" now' });
  });

  it("寛容モードでも解釈できない場合は元のJSON.parseのエラーを投げる", () => {
    expect(() => extractJson("これはJSONではありません")).toThrow();
  });
});
