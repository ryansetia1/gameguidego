// Which language the player wrote in, so the prompt can name it explicitly.
// Gemini 3 Flash drifted into Indonesian on English questions even with a clear
// "reply in the question's language" rule; naming the language fixed it (#31).
// ponytail: stopword vote for the two languages players actually use; anything
// else returns "" and the prompt's general language rule applies.

const ID_WORDS = new Set(
  "yang gimana bagaimana cara apa aku kamu gue lu di ke dari ini itu nya sih dong deh kok udah sudah belum buat untuk dengan bisa mau gak nggak enggak tidak ga kenapa mana dimana paling tolong ada dapat dapetin juga lagi terus karena kalau kalo harus boleh saja aja banget atau sama biar trus abis habis gimanakah apakah dimanakah kapan siapa berapa".split(" "),
);
const EN_WORDS = new Set(
  "the how what where which who why when do does did is are was were i you my your to of and in on can could should would get best with for it this that there a an have has".split(" "),
);

/** @param {string} text @returns {"English" | "Indonesian" | ""} */
function voteLanguage(text) {
  let id = 0;
  let en = 0;
  for (const word of String(text).toLowerCase().match(/[a-z]+/g) ?? []) {
    if (ID_WORDS.has(word)) id += 1;
    if (EN_WORDS.has(word)) en += 1;
  }
  if (id > en) return "Indonesian";
  if (en > id) return "English";
  return "";
}

/**
 * Language of the latest question; if it has no words to judge ("poin 3"), the
 * latest earlier player turn that does.
 * @param {string} question
 * @param {Array<{ role: string; content: string }>} [history]
 * @returns {"English" | "Indonesian" | ""}
 */
export function questionLanguage(question, history = []) {
  const direct = voteLanguage(question);
  if (direct) return direct;
  for (let i = history.length - 1; i >= 0; i -= 1) {
    if (history[i]?.role !== "user") continue;
    const earlier = voteLanguage(history[i].content);
    if (earlier) return earlier;
  }
  return "";
}
