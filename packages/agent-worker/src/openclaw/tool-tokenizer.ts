const CAMEL_CASE_BOUNDARY = /([\p{Ll}\p{N}])(\p{Lu})/gu;
const CJK_RUN =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu;
const LATIN_OR_NUMBER_WORD = /[\p{L}\p{N}]+/gu;

function stripControlCharacters(value: string): string {
  return [...value]
    .map((codepoint) => {
      const value = codepoint.codePointAt(0) ?? 0;
      return value <= 0x1f || (value >= 0x7f && value <= 0x9f)
        ? " "
        : codepoint;
    })
    .join("");
}

export function normalizeToolText(value: string): string {
  return stripControlCharacters(value.normalize("NFKC"))
    .replace(CAMEL_CASE_BOUNDARY, "$1 $2")
    .replace(/[_-]+/g, " ")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

export function tokenizeToolText(value: string): string[] {
  const normalized = normalizeToolText(value);
  const tokens: string[] = [];
  const seen = new Set<string>();
  const add = (token: string) => {
    if (!token || seen.has(token)) return;
    seen.add(token);
    tokens.push(token);
  };

  for (const segment of normalized.split(" ")) {
    if (!segment) continue;
    let cursor = 0;

    for (const match of segment.matchAll(CJK_RUN)) {
      const start = match.index;
      for (const word of segment
        .slice(cursor, start)
        .match(LATIN_OR_NUMBER_WORD) ?? []) {
        add(word);
      }

      const codepoints = [...match[0]];
      for (const codepoint of codepoints) add(codepoint);
      for (let index = 0; index + 1 < codepoints.length; index++) {
        const first = codepoints[index];
        const second = codepoints[index + 1];
        if (first !== undefined && second !== undefined) add(first + second);
      }
      cursor = start + match[0].length;
    }

    for (const word of segment.slice(cursor).match(LATIN_OR_NUMBER_WORD) ??
      []) {
      add(word);
    }
  }

  return tokens;
}
