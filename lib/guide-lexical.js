/**
 * Hybrid retrieval: find the proper-noun phrases in the English rewrite so a guide
 * can be retrieved by exact name.
 *
 * Embeddings are near-blind inside a single walkthrough because every paragraph
 * reads the same ("go north, defeat the X, open the chest"). On a real GameFAQs
 * guide the 20 nearest chunks spanned cosine 0.650–0.752, which is noise, and the
 * chunk naming the boss the player asked about sat at rank 16. A phrase match on
 * that name isolated it immediately and, just as importantly, did not drag in the
 * similarly named boss from another dungeon.
 *
 * Extraction is structural only (capitalisation plus position in the sentence), so
 * it carries no per-title vocabulary and works for any game.
 */

/**
 * A capital after a sentence break is grammar, so it is no evidence of a name.
 *
 * A colon is deliberately not a break. Guides label areas as "Level 3: Key Cavern",
 * and treating the colon as a sentence end made "Key" look sentence-initial, so the
 * phrase decayed to "cavern" and lost the word that distinguishes it.
 */
const SENTENCE_BREAK = /(?<=[.!?])\s+|\n+/u;

/** Punctuation ends a name; "Key Cavern (Level 3)" is two names, not one. */
const PHRASE_BREAK = /[^\p{L}\d'’\s-]+/u;

const CAPITALISED = /^[\p{Lu}][\p{L}'’-]*$/u;
/** A name may continue with another capital or a small number ("Level 3", "Act 2"). */
const CONTINUATION = /^(?:[\p{Lu}][\p{L}'’-]*|\d{1,3})$/u;

/** Capitalised mid-sentence yet still grammar. Kept tiny on purpose. */
const NOT_A_NAME = new Set(["i", "the", "a", "an", "of", "and", "or", "but", "if", "so"]);

/** Enough to name a subject and its place without bloating the tsquery. */
const MAX_PHRASES = 4;

/**
 * The lift given to the single best name match; later ranks get a fraction of it
 * (see `retrievalScore`).
 *
 * `lib/guide-rescore.js` deltas reach ±0.18, which is wider than the cosine spread
 * within a guide, so any retrieval signal smaller than that gets overruled by the
 * heuristics. 0.25 keeps the best exact-name match on top of a single wrong rule
 * while still letting two rules together override it.
 */
export const LEXICAL_HIT_BONUS = 0.25;

/**
 * Same shape on both sides of a comparison, and safe to paste into a tsquery.
 *
 * @param {string} word
 */
const normWord = (word) =>
  String(word)
    .replace(/['’]s$/u, "")
    .replace(/[^\p{L}\d]/gu, "")
    .toLowerCase();

/**
 * A guide about one game says that game's name constantly, so a phrase built only
 * from title words matches everywhere and ranks nothing. On a Zelda guide "Link"
 * is a real proper noun, and useless: it appeared in most chunks and outvoted the
 * boss name the player actually asked about. A phrase that merely *contains* a
 * title word is kept, since "Link's House" still points somewhere specific.
 *
 * @param {string[]} words
 * @param {Set<string>} titleWords
 */
const isAllTitleWords = (words, titleWords) =>
  titleWords.size > 0 && words.every((word) => titleWords.has(normWord(word)));

/**
 * Proper-noun phrases from a rewritten English query, most specific first.
 *
 * @param {string} text
 * @param {string} [gameName] drops phrases that are only the game's own name
 * @returns {string[]} lowercase, single-spaced phrases
 */
export function extractEntityPhrases(text, gameName) {
  /** @type {string[][]} */
  const found = [];

  for (const sentence of String(text ?? "").split(SENTENCE_BREAK)) {
    let consumed = 0;
    for (const segment of sentence.split(PHRASE_BREAK)) {
      /** @type {string[]} */
      let run = [];
      const flush = () => {
        if (run.length) found.push(run);
        run = [];
      };

      for (const token of segment.trim().split(/\s+/).filter(Boolean)) {
        const sentenceInitial = consumed === 0;
        consumed += 1;

        if (run.length && CONTINUATION.test(token)) {
          run.push(token.toLowerCase());
          continue;
        }
        flush();
        if (sentenceInitial || !CAPITALISED.test(token)) continue;
        if (NOT_A_NAME.has(token.toLowerCase())) continue;
        run.push(token.toLowerCase());
      }
      flush();
    }
  }

  const titleWords = new Set(
    String(gameName ?? "")
      .split(/[^\p{L}\d]+/u)
      .map(normWord)
      .filter(Boolean),
  );

  const seen = new Set();
  return found
    .filter((words) => !isAllTitleWords(words, titleWords))
    .sort((a, b) => b.length - a.length)
    .map((words) => words.join(" "))
    .filter((phrase) => !seen.has(phrase) && seen.add(phrase))
    .slice(0, MAX_PHRASES);
}

/**
 * Postgres `to_tsquery` input matching any of the phrases as adjacent words.
 *
 * Both sides are stemmed by the `english` config, so a query saying "Slime Eye"
 * still matches a guide writing "Slime Eyes". Every character outside letters and
 * digits is dropped, so no tsquery operator can arrive from model output.
 *
 * @param {string[]} phrases
 * @returns {string} empty when nothing is worth searching for
 */
export function buildPhraseTsQuery(phrases) {
  const clauses = [];
  for (const phrase of Array.isArray(phrases) ? phrases : []) {
    const words = String(phrase).split(/[\s-]+/).map(normWord).filter(Boolean);
    if (words.length) clauses.push(`(${words.join(" <-> ")})`);
  }
  return clauses.join(" | ");
}

/**
 * Retrieval score the rescorer ranks on: cosine, lifted by how good a name match
 * the chunk was.
 *
 * The lift decays with `lexical_rank` because a flat bonus misreads both ends of
 * the range. Extraction cannot tell a distinctive name from a word the guide says
 * constantly, so on a Zelda guide it also searched for "Link" and "Cavern", 15 of
 * 34 candidates matched, and an equal bonus on all of them ranked nothing. On a
 * Pokémon guide the opposite: 5 of 24 matched, and a flat 0.25 outweighed a 0.23
 * cosine gap, promoting a chunk that merely says the boss's name over the one
 * describing what happens after she is beaten.
 *
 * Decaying by `sqrt(rank)` reads `lexical_rank` for what it is, a ranking by
 * `ts_rank`: the single best name match in the guide is worth far more than the
 * ninth. The square root rather than the rank itself, because `1/rank` overshot
 * and cost the Zelda case its answer entirely: the chunk that answered was only a
 * mediocre name match (rank 9), and stripping its lift dropped it out of the top-5
 * so the model went back to saying the guide did not cover the question. Measured
 * over four guides, `sqrt` is the only shape where every case retrieves its answer.
 *
 * @param {{ similarity?: number, lexical_rank?: number }} row
 * @returns {number}
 */
export function retrievalScore(row) {
  const cosine = Number(row?.similarity) || 0;
  const rank = Number(row?.lexical_rank) || 0;
  return rank > 0 ? cosine + LEXICAL_HIT_BONUS / Math.sqrt(rank) : cosine;
}
