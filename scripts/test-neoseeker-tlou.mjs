#!/usr/bin/env node
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

const GAME = "The Last of Us";
const SLUG = "the-last-of-us";
const HUB = `https://www.neoseeker.com/${SLUG}/walkthrough`;
const MIN = 15;

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeUrl(raw) {
  let url = raw.replace(/[.,;:!?)\\]]+$/, "").replace(/\)%20\d+$/i, "");
  const u = new URL(url);
  u.hostname = "www.neoseeker.com";
  u.hash = "";
  u.pathname = u.pathname.replace(/\/+$/, "");
  if (/\/(Special:|File:|Image:|forums\/)/i.test(u.pathname)) return null;
  const last = u.pathname.split("/").pop() || "";
  if (!last || last === SLUG || last.includes(")")) return null;
  return u.href;
}

function parseFlat(raw) {
  const re = new RegExp(
    `https?://(?:www\\.)?neoseeker\\.com/${escapeRe(SLUG)}/[A-Za-z0-9_%'(). -]+`,
    "gi",
  );
  const found = new Set();
  for (const m of raw.matchAll(re)) {
    const url = normalizeUrl(m[0]);
    if (url) found.add(url);
  }
  return [...found].sort();
}

function parseNested(raw) {
  const re = new RegExp(
    `https?://(?:www\\.)?neoseeker\\.com/${escapeRe(SLUG)}(?:/walkthrough/[A-Za-z0-9_%'(). -]+|/[A-Za-z0-9_%'(). -]+)`,
    "gi",
  );
  const found = new Set();
  for (const m of raw.matchAll(re)) {
    const url = normalizeUrl(m[0]);
    if (url) found.add(url);
  }
  return [...found].sort();
}

async function tavily(url) {
  const res = await fetch("https://api.tavily.com/extract", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: process.env.TAVILY_API_KEY,
      urls: [url],
      extract_depth: "advanced",
    }),
    signal: AbortSignal.timeout(120_000),
  });
  return (await res.json())?.results?.[0]?.raw_content || "";
}

async function directFetch(url) {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0" },
      signal: AbortSignal.timeout(15_000),
    });
    return { status: res.status, len: (await res.text()).length };
  } catch (e) {
    return { status: 0, error: e.message };
  }
}

async function serper(q) {
  const res = await fetch("https://google.serper.dev/search", {
    method: "POST",
    headers: { "X-API-KEY": process.env.SERPER_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ q, num: 20 }),
  });
  return ((await res.json()).organic || [])
    .filter((r) => r.link.includes(`neoseeker.com/${SLUG}/`))
    .map((r) => r.link);
}

console.log("=== The Last of Us — Neoseeker test ===\n");
console.log(`Hub: ${HUB}\n`);

const direct = await directFetch(HUB);
console.log(`1. Direct fetch: HTTP ${direct.status}${direct.len ? ` (${direct.len} chars)` : direct.error ? ` (${direct.error})` : ""}`);

const hubRaw = await tavily(HUB);
const flat = parseFlat(hubRaw);
const nested = parseNested(hubRaw);
console.log(`\n2. Hub Tavily extract: ${hubRaw.length} chars`);
console.log(`   flat parser:   ${flat.length} links → ${flat.length >= MIN ? "FULL" : "thin"}`);
console.log(`   nested parser: ${nested.length} links → ${nested.length >= MIN ? "FULL" : "thin"}`);

const allMentions = [
  ...new Set([...hubRaw.matchAll(/neoseeker\.com\/the-last-of-us[^\s"')]+/gi)].map((m) => m[0])),
];
console.log(`\n3. Raw link mentions in extract: ${allMentions.length}`);
allMentions.slice(0, 30).forEach((l) => console.log(`   ${l}`));
if (allMentions.length > 30) console.log(`   ... +${allMentions.length - 30} more`);

if (nested.length) {
  console.log("\n4. Discovered pages (nested parser):");
  nested.forEach((u, i) =>
    console.log(`   ${String(i + 1).padStart(2)}. ${u.replace(`https://www.neoseeker.com/${SLUG}/`, "")}`),
  );
}

const chapterCandidate =
  nested.find((u) => /walkthrough\//.test(u) && !u.endsWith("/walkthrough")) ||
  nested.find((u) => u !== HUB && !/File|Special/i.test(u));

if (chapterCandidate) {
  const chRaw = await tavily(chapterCandidate);
  const chLinks = parseNested(chRaw);
  console.log(`\n5. Chapter probe: ${chapterCandidate.split("/").slice(-2).join("/")}`);
  console.log(`   ${chRaw.length} chars | ${chLinks.length} links → ${chLinks.length >= MIN ? "FULL" : "thin"}`);
}

console.log("\n6. Serper:");
for (const q of [
  `${GAME} site:neoseeker.com/${SLUG}`,
  `site:neoseeker.com/${SLUG}`,
  `${GAME} neoseeker walkthrough`,
]) {
  const hits = await serper(q);
  console.log(`   "${q}" → ${hits.length}`);
  hits.slice(0, 5).forEach((u) => console.log(`     ${u}`));
}

if (nested.length < MIN) {
  console.log("\n7. Cascade fallback...");
  const all = new Set();
  const probes = [
    HUB,
    ...flat.filter((u) => /File:/i.test(u)).slice(0, 1),
    ...flat.filter((u) => !/File|Special|walkthrough/i.test(u)).slice(0, 2),
  ];
  for (const url of [...new Set(probes)]) {
    const raw = url === HUB ? hubRaw : await tavily(url);
    for (const l of parseNested(raw)) all.add(l);
    console.log(`   probe ${url.split("/").pop()} → total ${all.size}`);
  }
  console.log(`   cascade: ${all.size} pages → ${all.size >= MIN ? "FULL" : "FAIL"}`);
}

const pattern = allMentions.some((m) => m.includes("/walkthrough/"))
  ? "NESTED (/walkthrough/Chapter)"
  : flat.length > nested.length
    ? "FLAT (/slug/Page)"
    : nested.length > flat.length
      ? "NESTED"
      : "mixed/thin";

console.log("\n=== VERDICT ===");
console.log(`URL pattern: ${pattern}`);
console.log(
  `Hub alone (best parser): ${
    Math.max(flat.length, nested.length) >= MIN
      ? `FULL BUNDLE (${Math.max(flat.length, nested.length)} pages)`
      : `FAIL (flat=${flat.length}, nested=${nested.length})`
  }`,
);
console.log(`Cascade needed: ${Math.max(flat.length, nested.length) < MIN ? "YES" : "NO"}`);
