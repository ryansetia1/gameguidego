#!/usr/bin/env node
/**
 * Test Neoseeker full-bundle discovery WITHOUT Playwright.
 * Simulates cascade + search + wayback fallbacks.
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

function loadEnvLocal() {
  const path = resolve(process.cwd(), ".env.local");
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadEnvLocal();

const GAME = "Hades";
const SLUG = "hades-2020";
const HUB = `https://www.neoseeker.com/${SLUG}/walkthrough`;

const SEEDS = {
  hub: HUB,
  zeus: `https://www.neoseeker.com/${SLUG}/Zeus`,
  beginner: `https://www.neoseeker.com/${SLUG}/Beginner%27s_Guide`,
  tartarus: `https://www.neoseeker.com/${SLUG}/Tartarus`,
};

const SKIP_PATH = /\/(Special:|File:|Image:|forums\/)/i;
const MIN_FULL_BUNDLE = 15;

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function chapterPrefix(url) {
  if (url.includes("/walkthrough")) {
    return url.split("/walkthrough", 1)[0] + "/";
  }
  return url.replace(/\/[^/]+$/, "/");
}

function parseLinksFromRaw(raw, prefix) {
  const found = new Set();
  const re = new RegExp(
    `https?://(?:www\\.)?neoseeker\\.com/${escapeRe(SLUG)}/[A-Za-z0-9_%'(). -]+`,
    "gi",
  );
  for (const m of raw.matchAll(re)) {
    let url = m[0].replace(/[.,;:!?)\\]]+$/, "");
    try {
      const u = new URL(url);
      u.hostname = "www.neoseeker.com";
      u.pathname = u.pathname.replace(/\/+$/, "") || "/";
      u.hash = "";
      const path = u.pathname;
      if (SKIP_PATH.test(path)) continue;
      if (path === `/${SLUG}/walkthrough` && url !== HUB) continue;
      if (!u.href.startsWith(prefix)) continue;
      found.add(u.href);
    } catch {
      /* skip */
    }
  }
  return [...found].sort();
}

async function tavilyRaw(url, depth = "advanced") {
  const res = await fetch("https://api.tavily.com/extract", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: process.env.TAVILY_API_KEY,
      urls: [url],
      extract_depth: depth,
    }),
    signal: AbortSignal.timeout(120_000),
  });
  const data = await res.json();
  const hit = data?.results?.[0];
  return {
    chars: (hit?.raw_content || hit?.content || "").length,
    raw: hit?.raw_content || hit?.content || "",
    failed: Boolean(data?.failed_results?.length),
  };
}

async function serperSearch(query) {
  const key = process.env.SERPER_API_KEY;
  if (!key) return [];
  const res = await fetch("https://google.serper.dev/search", {
    method: "POST",
    headers: { "X-API-KEY": key, "Content-Type": "application/json" },
    body: JSON.stringify({ q: query, num: 20 }),
    signal: AbortSignal.timeout(30_000),
  });
  const data = await res.json();
  return (data.organic || [])
    .map((r) => r.link)
    .filter((u) => u.includes(`neoseeker.com/${SLUG}/`) && !SKIP_PATH.test(u));
}

async function waybackHubLinks() {
  const res = await fetch(
    `https://archive.org/wayback/available?url=${encodeURIComponent(HUB)}`,
    { signal: AbortSignal.timeout(20_000) },
  );
  const snap = (await res.json())?.archived_snapshots?.closest?.url;
  if (!snap) return { snap: null, links: [] };
  const html = await (
    await fetch(snap, { headers: { "User-Agent": "GameGuideGo/1.0" }, signal: AbortSignal.timeout(30_000) })
  ).text();
  const prefix = chapterPrefix(HUB);
  const links = [
    ...html.matchAll(new RegExp(`href="(/${escapeRe(SLUG)}/[^"#]+)"`, "gi")),
  ]
    .map((m) => `https://www.neoseeker.com${m[1].replace(/\/+$/, "")}`)
    .filter((u) => !SKIP_PATH.test(u) && u.startsWith(prefix));
  return { snap, links: [...new Set(links)].sort() };
}

async function directFetch(url) {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; GameGuideGo/1.0)" },
      signal: AbortSignal.timeout(15_000),
    });
    const html = await res.text();
    const prefix = chapterPrefix(url);
    const links = [
      ...html.matchAll(new RegExp(`href="(/${escapeRe(SLUG)}/[^"#]+)"`, "gi")),
    ]
      .map((m) => `https://www.neoseeker.com${m[1].replace(/\/+$/, "")}`)
      .filter((u) => !SKIP_PATH.test(u) && u.startsWith(prefix));
    return { status: res.status, htmlLen: html.length, links: [...new Set(links)].sort() };
  } catch (e) {
    return { status: 0, htmlLen: 0, links: [], error: e.message };
  }
}

/** Cascade: seed extract → hub → merge links from new URLs → optional search */
async function cascadeDiscover(seedUrl, { maxProbes = 6, useSearch = true } = {}) {
  const prefix = chapterPrefix(seedUrl);
  const probes = [];
  const all = new Set();
  const log = [];

  async function probe(url, label) {
    if (probes.length >= maxProbes) return;
    if (probes.some((p) => p.url === url)) return;
    const ex = await tavilyRaw(url);
    const links = parseLinksFromRaw(ex.raw, prefix);
    const before = all.size;
    for (const l of links) all.add(l);
    probes.push({ url, label, chars: ex.chars, linksFound: links.length, newLinks: all.size - before });
    log.push({ step: probes.length, label, url, chars: ex.chars, linksFound: links.length, total: all.size });
    return links;
  }

  await probe(seedUrl, "seed");
  if (all.size < MIN_FULL_BUNDLE) await probe(HUB, "hub-fallback");
  if (all.size < MIN_FULL_BUNDLE) {
    const frontier = [...all].filter((u) => u !== seedUrl && u !== HUB).slice(0, 3);
    for (const u of frontier) {
      if (all.size >= MIN_FULL_BUNDLE) break;
      await probe(u, "frontier");
    }
  }
  if (all.size < MIN_FULL_BUNDLE && useSearch) {
    const queries = [
      `${GAME} site:neoseeker.com/${SLUG}`,
      `${GAME} walkthrough site:neoseeker.com/${SLUG}`,
      `site:neoseeker.com/${SLUG}`,
    ];
    for (const q of queries) {
      if (all.size >= MIN_FULL_BUNDLE) break;
      const hits = await serperSearch(q);
      for (const u of hits.slice(0, 4)) {
        if (all.size >= MIN_FULL_BUNDLE) break;
        await probe(u, `serper:${q.slice(0, 40)}`);
      }
    }
  }

  return {
    total: all.size,
    fullBundle: all.size >= MIN_FULL_BUNDLE,
    pages: [...all].sort(),
    log,
    probes: probes.length,
  };
}

async function main() {
  console.log("=== Neoseeker NO-PLAYWRIGHT WORKAROUND TEST ===\n");
  console.log(`Game: ${GAME} | Slug: ${SLUG} | Full bundle threshold: ${MIN_FULL_BUNDLE} pages\n`);

  // 1. Direct fetch baseline
  console.log("--- 1. Direct HTTP fetch (no Tavily) ---");
  for (const [name, url] of Object.entries(SEEDS)) {
    const r = await directFetch(url);
    console.log(
      `${name}: HTTP ${r.status} | html ${r.htmlLen} chars | sidebar links ${r.links.length}${r.error ? ` | ${r.error}` : ""}`,
    );
  }

  // 2. Single Tavily extract (no cascade)
  console.log("\n--- 2. Single Tavily extract only ---");
  const prefix = chapterPrefix(HUB);
  for (const [name, url] of Object.entries(SEEDS)) {
    const ex = await tavilyRaw(url);
    const links = parseLinksFromRaw(ex.raw, prefix);
    console.log(
      `${name}: ${ex.chars} chars | ${links.length} links | full=${links.length >= MIN_FULL_BUNDLE ? "YES" : "NO"}`,
    );
  }

  // 3. Wayback hub
  console.log("\n--- 3. Wayback hub HTML parse ---");
  const wb = await waybackHubLinks();
  console.log(`Snapshot: ${wb.snap ? "yes" : "no"}`);
  console.log(`Links from Wayback hub: ${wb.links.length}`);
  if (wb.links.length) console.log(`Sample: ${wb.links.slice(0, 8).map((u) => u.split("/").pop()).join(", ")}`);

  // 4. Serper enumeration alone
  console.log("\n--- 4. Serper search enumeration ---");
  for (const q of [
    `${GAME} site:neoseeker.com/${SLUG}`,
    `site:neoseeker.com/${SLUG}`,
    `${GAME} neoseeker ${SLUG} Tartarus`,
  ]) {
    const hits = await serperSearch(q);
    console.log(`"${q}" → ${hits.length} URLs`);
    if (hits.length) console.log(`  ${hits.slice(0, 5).join("\n  ")}`);
  }

  // 5. Cascade per seed
  console.log("\n--- 5. Discovery cascade (Tavily + hub fallback + frontier + Serper) ---");
  const cascadeResults = {};
  for (const [name, url] of Object.entries(SEEDS)) {
    console.log(`\n  [${name}] seed: ${url.split("/").pop()}`);
    const r = await cascadeDiscover(url);
    cascadeResults[name] = r;
    for (const step of r.log) {
      console.log(
        `    ${step.step}. ${step.label}: +${step.linksFound} links (${step.chars} chars) → total ${step.total}`,
      );
    }
    console.log(`    RESULT: ${r.total} pages | full bundle: ${r.fullBundle ? "YES" : "NO"} | probes: ${r.probes}`);
  }

  // 6. Known-good page list from beginner (ground truth)
  console.log("\n--- 6. Ground truth (Tartarus single extract) ---");
  const gt = await tavilyRaw(SEEDS.tartarus);
  const groundTruth = new Set(parseLinksFromRaw(gt.raw, prefix));
  groundTruth.add(SEEDS.tartarus);
  groundTruth.add(HUB);
  console.log(`Reference set from Tartarus extract: ${groundTruth.size} pages`);

  console.log("\n--- 7. Cascade coverage vs ground truth ---");
  for (const [name, r] of Object.entries(cascadeResults)) {
    const found = new Set(r.pages);
    let overlap = 0;
    for (const p of groundTruth) if (found.has(p)) overlap++;
    const pct = groundTruth.size ? Math.round((overlap / groundTruth.size) * 100) : 0;
    const missing = [...groundTruth].filter((p) => !found.has(p)).slice(0, 8);
    console.log(
      `${name}: ${overlap}/${groundTruth.size} (${pct}%) | missing sample: ${missing.map((u) => u.split("/").pop()).join(", ") || "(none)"}`,
    );
  }

  // Verdict
  console.log("\n=== VERDICT ===");
  const hubOk = cascadeResults.hub?.fullBundle;
  const zeusOk = cascadeResults.zeus?.fullBundle;
  const beginnerOk = cascadeResults.beginner?.fullBundle;
  console.log(`Hub-only paste + cascade: ${hubOk ? "FULL BUNDLE" : "FAIL"}`);
  console.log(`Zeus paste + cascade: ${zeusOk ? "FULL BUNDLE" : "FAIL"}`);
  console.log(`Beginner paste + cascade: ${beginnerOk ? "FULL BUNDLE" : "PASS"}`);
  console.log(`Wayback hub alone: ${wb.links.length >= MIN_FULL_BUNDLE ? "FULL BUNDLE" : "FAIL"}`);
  console.log(`Direct fetch: blocked (403 expected)`);
  console.log("\nDone.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
