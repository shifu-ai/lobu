export const INVALID_UTF16_ERROR = "invalid UTF-16 string: unpaired surrogate";

/** Total UTF-16 validator. It never repairs malformed input or substitutes U+FFFD. */
export function assertWellFormedUnicode(value: string): void {
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new TypeError(INVALID_UTF16_ERROR);
      }
      index++;
      continue;
    }
    if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new TypeError(INVALID_UTF16_ERROR);
    }
  }
}
