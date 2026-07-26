/**
 * Bottle Grotto turns 1–4 regression (preferred guide RAG).
 * Usage: node scripts/test-la-turns-1-4.mjs [baseUrl]
 */

const BASE = process.argv[2] ?? "http://localhost:3000";
const GUIDE =
  "https://gamefaqs.gamespot.com/gameboy/563277-the-legend-of-zelda-links-awakening/faqs/18445";

const TURNS = [
  {
    label: "T1 PB",
    question:
      "di bottle grotto, aku baru aja buka peti untuk dapetin power bracelet, setelah itu kemana ya?",
    checks: (a) => ({
      lift_pots: /angkat pot|lift.*pot/i.test(a),
      crystal: /crystal|switch|kristal/i.test(a),
      forward_jump: /outside.*grotto|brought back outside/i.test(a),
    }),
  },
  {
    label: "T2 Key",
    question: "setelah dapet kunci kemana lagi?",
    checks: (a) => ({
      nightmare_key: /nightmare|mimpi buruk/i.test(a),
      forward_jump: /outside.*grotto|overworld|wind fish/i.test(a),
    }),
  },
  {
    label: "T3 after NK",
    question: "trus setelah itu kemana?",
    checks: (a) => ({
      basement: /basement|bawah|elevator/i.test(a),
      stairs: /tangga|stairs|barat|west/i.test(a),
      hinox: /hinox/i.test(a),
    }),
  },
  {
    label: "T4 stairs",
    question: "udah turun elevator dan ke barat naik tangga, setelah itu?",
    checks: (a) => ({
      genie: /genie|jin/i.test(a),
      conch: /conch|horn|sangkakala/i.test(a),
      hinox: /hinox/i.test(a),
      dark_room: /ruangan gelap|dark room/i.test(a),
    }),
  },
];

async function solveTurn({ question, history, traceId }) {
  const res = await fetch(`${BASE}/api/solve`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Trace-Id": traceId,
    },
    body: JSON.stringify({
      game: "The Legend of Zelda: Link's Awakening",
      platform: "Game Boy",
      question,
      preferredUrls: [GUIDE],
      spoilerPrefs: { major: false },
      history,
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);

  const raw = await res.text();
  let result = null;
  let context = null;
  for (const block of raw.split("\n\n")) {
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
  return { answer: result.answer, context, pipeline: result.pipelineType };
}

async function runSuite(label) {
  const suiteId = crypto.randomUUID().slice(0, 8);
  /** @type {{ role: string, content: string }[]} */
  const history = [];
  const rows = [];

  for (let i = 0; i < TURNS.length; i++) {
    const turn = TURNS[i];
    const traceId = `${suiteId}-t${i + 1}-${crypto.randomUUID()}`;
    const started = Date.now();
    const { answer, context, pipeline } = await solveTurn({
      question: turn.question,
      history,
      traceId,
    });
    const checks = turn.checks(answer);
    const preferredCount = context?.sources?.filter((s) => s.preferred)?.length ?? 0;
    const rank1 = (context?.sources?.[0]?.content ?? "").slice(0, 80);

    rows.push({
      turn: turn.label,
      traceId,
      latencyMs: Date.now() - started,
      pipeline,
      preferredCount,
      rank1Preview: rank1,
      checks,
      answerHead: answer.replace(/\s+/g, " ").slice(0, 220),
    });

    history.push({ role: "user", content: turn.question });
    history.push({ role: "assistant", content: answer });
  }

  return { label, suiteId, rows };
}

const out = await runSuite(process.env.SUITE_LABEL ?? "run");
console.log(JSON.stringify(out, null, 2));
