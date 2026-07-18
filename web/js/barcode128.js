// Code 128 barcode encoder (from scratch; ISO/IEC 15417).
//
// Returns the module-width sequence for a value: alternating bar/space
// widths starting with a bar, including start code, checksum and stop
// pattern. Rendering is left to the caller (elements.js draws bars as
// pure-black integer-width fills, so output survives 1-bpp untouched).
//
// Code set B covers printable ASCII 32..126; runs of digits are packed
// two-per-symbol via code set C when it saves symbols.

// Widths per symbol value 0..106 (6 digits = 3 bars + 3 spaces, 11 modules).
const PATTERNS = (
  "212222 222122 222221 121223 121322 131222 122213 122312 132212 221213 " +
  "221312 231212 112232 122132 122231 113222 123122 123221 223211 221132 " +
  "221231 213212 223112 312131 311222 321122 321221 312212 322112 322211 " +
  "212123 212321 232121 111323 131123 131321 112313 132113 132311 211313 " +
  "231113 231311 112133 112331 132131 113123 113321 133121 313121 211331 " +
  "231131 213113 213311 213131 311123 311321 331121 312113 312311 332111 " +
  "314111 221411 431111 111224 111422 121124 121421 141122 141221 112214 " +
  "112412 122114 122411 142112 142211 241211 221114 413111 241112 134111 " +
  "111242 121142 121241 114212 124112 124211 411212 421112 421211 212141 " +
  "214121 412121 111143 111341 131141 114113 114311 411113 411311 113141 " +
  "114131 311141 411131 211412 211214 211232"
).split(" ");
const STOP = "2331112"; // 13 modules, ends with the 2-module termination bar

const CODE_C = 99; // switch symbol inside code set B
const CODE_B = 100; // switch symbol inside code set C
const START_B = 104;
const START_C = 105;

function digitRunLength(text, i) {
  let n = 0;
  while (i + n < text.length && text[n + i] >= "0" && text[n + i] <= "9") n++;
  return n;
}

/**
 * Encode text; returns { widths: number[], modules: number, symbols: number }
 * or null when the text contains characters outside printable ASCII.
 */
export function encode128(text) {
  if (!text || [...text].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) > 126)) {
    return null;
  }

  // Symbol values, choosing B or C per position: enter/stay in C for digit
  // runs long enough to pay for the switch (4+ covering the whole value,
  // else 6+ mid-string), consuming an even number of digits.
  const values = [];
  let i = 0;
  let set = null; // "B" | "C"
  while (i < text.length) {
    const run = digitRunLength(text, i);
    const wholeString = i === 0 && run === text.length;
    if (run >= (wholeString ? 4 : 6)) {
      const take = run % 2 === 0 ? run : run - 1; // C consumes digit pairs
      if (set === null) values.push(START_C);
      else if (set !== "C") values.push(CODE_C);
      set = "C";
      for (let k = 0; k < take; k += 2) {
        values.push(Number(text.slice(i + k, i + k + 2)));
      }
      i += take;
    } else {
      if (set === null) values.push(START_B);
      else if (set !== "B") values.push(CODE_B);
      set = "B";
      values.push(text.charCodeAt(i) - 32);
      i += 1;
    }
  }

  // Checksum: start value + Σ position·value, mod 103.
  let sum = values[0];
  for (let k = 1; k < values.length; k++) sum += k * values[k];
  values.push(sum % 103);

  const widths = [];
  for (const v of values) for (const ch of PATTERNS[v]) widths.push(Number(ch));
  for (const ch of STOP) widths.push(Number(ch));
  const modules = widths.reduce((a, b) => a + b, 0);
  return { widths, modules, symbols: values.length };
}
