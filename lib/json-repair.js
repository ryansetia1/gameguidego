/**
 * Best-effort repair of structurally-broken JSON from an LLM. Gemini occasionally
 * emits the wrong closing bracket (`}` where `]` belongs), a stray extra closer, a
 * trailing comma, or truncates the tail mid-value (its internal reasoning burns a
 * variable, sometimes large, slice of the output budget). This rewrites every closer
 * to match the innermost open bracket, closes a string left open by truncation, drops
 * stray closers / trailing commas / a dangling `"key":` with no value, and closes
 * anything still open.
 *
 * Only meant as a fallback after a strict `JSON.parse` throws. The output is not
 * guaranteed valid, but it salvages the common Gemini failures; re-`JSON.parse` and
 * fall back to null if it still throws. Complete leading data (e.g. the style object
 * and any games that finished) survives even when the tail is cut off.
 *
 * @param {string} text
 * @returns {string}
 */
export function repairJsonStructure(text) {
  /** @type {string[]} */
  const stack = [];
  let out = "";
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === "{" || ch === "[") {
      stack.push(ch);
      out += ch;
      continue;
    }
    if (ch === "}" || ch === "]") {
      if (!stack.length) continue; // stray closer, drop it
      out = trimDanglingBeforeClose(out);
      out += stack.pop() === "{" ? "}" : "]";
      continue;
    }
    out += ch;
  }

  if (inString) out += '"'; // truncated mid-string: close it
  while (stack.length) {
    out = trimDanglingBeforeClose(out);
    out += stack.pop() === "{" ? "}" : "]";
  }
  return out;
}

/** Drop a trailing comma and any dangling `"key":` (a truncated key/value) before a closer. @param {string} s */
function trimDanglingBeforeClose(s) {
  return s
    .replace(/,\s*$/, "")
    .replace(/,?\s*"(?:[^"\\]|\\.)*"\s*:\s*$/, "");
}

/** ponytail: self-check for the repair — run via `npm run check`. @returns {boolean} */
export function demoJsonRepair() {
  /** @param {string} broken @param {string} expected */
  const parses = (broken, expected) =>
    JSON.stringify(JSON.parse(repairJsonStructure(broken))) === expected;

  // Wrong closer (`}` for a `]`) plus a stray extra closer — a real Gemini failure.
  if (!parses('{"a":[{"n":["x"}]}]}', '{"a":[{"n":["x"]}]}')) return false;
  // Truncated mid-structure (unclosed brackets).
  if (!parses('{"a":[1,2', '{"a":[1,2]}')) return false;
  // Truncated mid-string inside an array — the actual Gemini truncation.
  if (!parses('{"g":[{"n":["done","half of a no', '{"g":[{"n":["done","half of a no"]}]}')) {
    return false;
  }
  // Truncated right after a key + colon (dangling value).
  if (!parses('{"a":1,"b":', '{"a":1}')) return false;
  // Trailing comma.
  if (!parses('{"a":[1,2,]}', '{"a":[1,2]}')) return false;
  // Valid input is unchanged in meaning.
  if (!parses('{"a":1}', '{"a":1}')) return false;
  return true;
}
