#!/usr/bin/env node
/**
 * One-off: Neoseeker no-Playwright test for Uncharted 4 walkthrough.
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

const GAME = "Uncharted 4";
const SLUG = "uncharted-4";
const HUB = `https://www.neoseeker.com/${SLUG}/walkthrough`;
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
      if (/\/(Special:|File:|Image:|forums\/)/i.test(u.pathname)) continue;
      if (!u.href.startsWith(prefix)) continue;
      // ponytail: strip markdown punctuation artifacts
      const slug = u.pathname.split("/").pop() || "";
      if (!slug || slug.includes(")")) continue;
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
  const raw = hit?.raw_content || hit?.content || "";
  return { chars: raw.length, raw, failed: Boolean(data?.failed_results?.length) };
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
    .filter((u) => u.includes(`neoseeker.com/${SLUG}/`) && !/\/(Special:|File:|forums\/)/i.test(u));
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
      .filter((u) => !/\/(Special:|File:|forums\/)/i.test(u) && u.startsWith(prefix));
    return { status: res.status, htmlLen: html.length, links: [...new Set(links)].sort() };
  } catch (e) {
    return { status: 0, htmlLen: 0, links: [], error: e.message };
  }
}

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
    log.push({
      step: probes.length,
      label,
      url,
      chars: ex.chars,
      linksFound: links.length,
      newLinks: all.size - before,
      total: all.size,
      sample: links.slice(0, 5).map((u) => u.split("/").pop()),
    });
    return links;
  }

  await probe(seedUrl, "seed");
  if (all.size < MIN_FULL_BUNDLE) await probe(HUB, "hub-fallback");
  if (all.size < MIN_FULL_BUNDLE) {
    const fileLinks = [...all].filter((u) => /\/File:/i.test(u));
    for (const u of fileLinks.slice(0, 2)) {
      if (all.size >= MIN_FULL_BUNDLE) break;
      await probe(u, "file-frontier");
    }
  }
  if (all.size < MIN_FULL_BUNDLE) {
    const frontier = [...all].filter((u) => u !== seedUrl && u !== HUB && !/\/File:/i.test(u)).slice(0, 3);
    for (const u of frontier) {
      if (all.size >= MIN_FULL_BUNDLE) break;
      await probe(u, "frontier");
    }
  }
  if (all.size < MIN_FULL_BUNDLE && useSearch) {
    for (const q of [
      `${GAME} site:neoseeker.com/${SLUG}`,
      `site:neoseeker.com/${SLUG}`,
      `${GAME} neoseeker walkthrough`,
    ]) {
      if (all.size >= MIN_FULL_BUNDLE) break;
      for (const u of (await serperSearch(q)).slice(0, 4)) {
        if (all.size >= MIN_FULL_BUNDLE) break;
        await probe(u, `serper`);
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
  console.log("=== Neoseeker Uncharted 4 — NO-PLAYWRIGHT TEST ===\n");
  console.log(`Hub: ${HUB}\n`);

  console.log("--- 1. Direct HTTP fetch ---");
  const hubFetch = await directFetch(HUB);
  console.log(`hub: HTTP ${hubFetch.status} | html ${hubFetch.htmlLen} | links ${hubFetch.links.length}`);

  console.log("\n--- 2. Hub single Tavily extract ---");
  const hubEx = await tavilyRaw(HUB);
  const prefix = chapterPrefix(HUB);
  const hubLinks = parseLinksFromRaw(hubEx.raw, prefix);
  console.log(`chars: ${hubEx.chars} | links: ${hubLinks.length}`);
  console.log(`hub links found: ${hubLinks.map((u) => u.split("/").pop()).join(", ") || "(none)"}`);
  console.log(`preview: ${hubEx.raw.slice(0, 350).replace(/\s+/g, " ")}...`);

  console.log("\n--- 3. Serper enumeration ---");
  for (const q of [`${GAME} site:neoseeker.com/${SLUG}`, `site:neoseeker.com/${SLUG}`, `${GAME} neoseeker walkthrough`]) {
    const hits = await serperSearch(q);
    console.log(`"${q}" → ${hits.length}`);
    hits.slice(0, 8).forEach((u) => console.log(`  ${u}`));
  }

  console.log("\n--- 4. Cascade from hub ---");
  const cascade = await cascadeDiscover(HUB);
  for (const step of cascade.log) {
    console.log(
      `  ${step.step}. ${step.label} [${step.url.split("/").pop()}]: +${step.newLinks} new (${step.linksFound} parsed, ${step.chars} chars) → total ${step.total}`,
    );
    if (step.sample?.length) console.log(`     sample: ${step.sample.join(", ")}`);
  }
  console.log(`\nRESULT: ${cascade.total} pages | full bundle (>=${MIN_FULL_BUNDLE}): ${cascade.fullBundle ? "YES" : "NO"} | probes: ${cascade.probes}`);

  if (cascade.pages.length) {
    console.log("\nAll discovered pages:");
    cascade.pages.forEach((u, i) => console.log(`  ${String(i + 1).padStart(2)}. ${u.split("/").pop()} → ${u}`));
  }

  console.log("\n=== VERDICT ===");
  console.log(`Direct fetch: ${hubFetch.status === 403 ? "BLOCKED (403)" : hubFetch.status}`);
  console.log(`Hub alone: ${hubLinks.length >= MIN_FULL_BUNDLE ? "FULL" : "THIN"} (${hubLinks.length} links)`);
  console.log(`Cascade from hub: ${cascade.fullBundle ? "FULL BUNDLE" : "FAIL"} (${cascade.total} pages, ${cascade.probes} probes)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
