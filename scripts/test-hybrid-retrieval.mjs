/**
 * Hybrid (vector + exact-name) preferred-guide retrieval regression.
 *
 * Motivated by trace 14a03ed6: cosine ranked the answering chunk 16th of 20 inside a
 * single walkthrough, so the model never saw it and invented a next dungeon. Each case
 * below asks about a named entity and asserts the retrieved rank-1 excerpt actually
 * names it. Four unrelated games, because the extraction must not be per-title.
 *
 * Usage: node scripts/test-hybrid-retrieval.mjs [baseUrl]
 * Requires: the dev server running, and each guide already ingested.
 */

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const BASE = process.argv[2] ?? "http://localhost:3000";

for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
);

const LINKS_AWAKENING =
  "https://gamefaqs.gamespot.com/gameboy/563277-the-legend-of-zelda-links-awakening/faqs/18445";

/** The exact turn that failed, with the history it ran against. */
const KEY_CAVERN_HISTORY = [
  { role: "user", content: "Aku bahkan udah ketemu portal kedua dan udah bisa bolak balik lho, trus kemana lagi nih, lanjut ke key cavern atau ke richard villa?" },
  { role: "assistant", content: "Untuk langkah selanjutnya, kamu perlu menuju ke Richard's Villa dulu ya, bukan ke Key Cavern." },
  { role: "user", content: "Oke, gimana menuju ke kanalet castle?" },
  { role: "assistant", content: "Setelah kamu setuju membantu Richard, tujuan kita selanjutnya adalah Kanalet Castle untuk mencari lima Golden Leaves." },
  { role: "user", content: "Oke aku udah menelusuri kanalet castle semampuku, dan udah dapet 4 golden leaves, kurang 1 nih" },
  { role: "assistant", content: "Untuk mendapatkan Golden Leaf yang terakhir, kalahkan Knight mini-boss di Kanalet Castle." },
  { role: "user", content: "Oke aku udah kasih 5 golden leavesny ke richard, udah ngambil secret seashell juga, bahkan udah ngegali tanah di depan owl buat dapetin slime key. Selanjutnya kemana nih?" },
  { role: "assistant", content: "Kamu sudah siap untuk menuju dungeon berikutnya, yaitu Key Cavern!" },
  { role: "user", content: "Oke aku baru aja masuk ke level 3: key cavern nih" },
  { role: "assistant", content: "Selamat datang di Level 3: Key Cavern! Angkat pot di dekatmu dan lemparkan ke pintu yang terkunci." },
];

const CASES = [
  {
    label: "Zelda LA — the trace 14a03ed6 turn",
    game: "The Legend of Zelda: Link's Awakening",
    platform: "Game Boy",
    guide: LINKS_AWAKENING,
    history: KEY_CAVERN_HISTORY,
    question: "Aku udah berhasil melawan boss mata di key cavern, selanjutnya ngapain ya?",
    // The guide paragraph that answers this names the boss and the reward.
    rank1Names: /slime eyes|sea lily/i,
    answerWants: /sea lily|yarna|dream shrine|ocarina/i,
    answerRejects: /face shrine|face key/i,
  },
  {
    label: "Pokemon Platinum — 1093 chunks, worst case for cosine",
    game: "Pokemon Platinum Version",
    platform: "Nintendo DS",
    guide: "https://gamefaqs.gamespot.com/ds/946308-pokemon-platinum-version/faqs/54062",
    history: [],
    question: "Aku udah ngalahin Gardenia di Eterna Gym, terus ngapain?",
    // Deliberately not /gardenia/: the chunk about *entering* the gym names her too,
    // and matching it hid the regression this case exists to catch. Only the chunk
    // describing what follows the win mentions the badge she leaves behind.
    rank1Names: /forest badge/i,
  },
  {
    label: "Final Fantasy VIII — different genre, different guide author",
    game: "Final Fantasy VIII",
    platform: "PlayStation 4",
    guide: "https://gamefaqs.gamespot.com/ps4/266152-final-fantasy-viii-remastered/faqs/50775",
    history: [],
    question: "Aku baru aja ngalahin Ifrit di Fire Cavern, selanjutnya ngapain?",
    rank1Names: /ifrit|fire cavern/i,
  },
  {
    label: "Castlevania SotN — English question",
    game: "Castlevania: Symphony of the Night",
    platform: "PlayStation",
    guide: "https://gamefaqs.gamespot.com/ps/196885-castlevania-symphony-of-the-night/faqs/3789",
    history: [],
    question: "Where should I go after beating Slogra and Gaibon?",
    rank1Names: /slogra|gaibon/i,
  },
];

async function solve(testCase, traceId) {
  const res = await fetch(`${BASE}/api/solve`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Trace-Id": traceId },
    body: JSON.stringify({
      game: testCase.game,
      platform: testCase.platform,
      question: testCase.question,
      preferredUrls: [testCase.guide],
      spoilerPrefs: { major: false },
      history: testCase.history,
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);

  let result = null;
  let context = null;
  for (const block of (await res.text()).split("\n\n")) {
    let event = "";
    let data = null;
    for (const line of block.split("\n")) {
      if (line.startsWith("event: ")) event = line.slice(7);
      if (line.startsWith("data: ")) data = JSON.parse(line.slice(6));
    }
    if (event === "result") result = data;
    if (event === "context_ready") context = data;
  }
  if (!result?.answer) throw new Error(`No result for trace ${traceId}`);
  return { answer: result.answer, context };
}

/** rag_db_check carries the phrases we searched for and how many chunks they matched. */
async function lexicalTrace(traceId) {
  const { data } = await supabase
    .from("trace_events")
    .select("metadata")
    .eq("trace_id", traceId)
    .eq("event_type", "rag_db_check")
    .maybeSingle();
  return data?.metadata ?? {};
}

let failures = 0;
for (const testCase of CASES) {
  const traceId = crypto.randomUUID();
  const started = Date.now();
  const { answer, context } = await solve(testCase, traceId);
  const lex = await lexicalTrace(traceId);

  const preferred = (context?.sources ?? []).filter((s) => s.preferred);
  // Rank of the first excerpt that actually names what the player asked about.
  // Not necessarily rank 1: the model reads the whole set, so top-3 is the bar.
  const subjectRank = preferred.findIndex((s) => testCase.rank1Names.test(s.content ?? "")) + 1;
  const checks = {
    rag_pipeline: context?.pipelineType === "rag",
    lexical_search_ran: (lex.lexicalPhrases ?? []).length > 0,
    lexical_found_chunks: (lex.lexicalHits ?? 0) > 0,
    subject_in_top3: subjectRank >= 1 && subjectRank <= 3,
  };
  if (testCase.answerWants) checks.answer_correct = testCase.answerWants.test(answer);
  if (testCase.answerRejects) checks.answer_not_hallucinated = !testCase.answerRejects.test(answer);

  const failed = Object.entries(checks).filter(([, ok]) => !ok);
  if (failed.length) failures += 1;

  console.log(`\n${failed.length ? "FAIL" : "PASS"}  ${testCase.label}`);
  console.log(`  trace     : ${traceId}  (${Date.now() - started}ms)`);
  console.log(`  phrases   : ${JSON.stringify(lex.lexicalPhrases ?? [])}`);
  console.log(`  candidates: ${lex.candidateCount ?? "?"} (lexical hits ${lex.lexicalHits ?? 0})`);
  console.log(`  subject at: rank ${subjectRank || "not retrieved"} of ${preferred.length}`);
  for (const [name, ok] of Object.entries(checks)) console.log(`  ${ok ? "ok  " : "FAIL"} ${name}`);
  if (failed.length) console.log(`  answer    : ${answer.replace(/\s+/g, " ").slice(0, 300)}`);
}

console.log(`\n${failures ? `${failures} case(s) failed` : `All ${CASES.length} cases passed`}`);
process.exit(failures ? 1 : 0);
