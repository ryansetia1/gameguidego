#!/usr/bin/env node
/**
 * IGN guide pattern research — extract, link discovery, chunk quality.
 * Docs: docs/plan/ign-wiki-bundle.md, docs/plan/guide-providers.md
 * Usage: node scripts/test-ign-guide.mjs
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { chunkGuideWithMeta } from "../lib/chunk-guide.js";
import { cleanSnippet } from "../lib/clean.js";

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

const URLS = {
  wikiChapter:
    "https://www.ign.com/wikis/pokemon-diamond-pearl-platinum-version/Route_201_to_Sandgem_Town",
  wikiHub:
    "https://www.ign.com/wikis/pokemon-diamond-pearl-platinum-version/Walkthrough",
  wikiGuideRoot:
    "https://www.ign.com/wikis/pokemon-diamond-pearl-platinum-version",
  walkthroughsLegacy:
    "https://www.ign.com/walkthroughs/pokemon-diamond-version",
  walkthroughsChapter:
    "https://www.ign.com/walkthroughs/pokemon-diamond-version/page-2",
};

const NOISE_PATTERNS = [
  /ign logo/i,
  /skip to content/i,
  /create a free account/i,
  /sign in/i,
  /task search/i,
  /checklists/i,
  /was this guide helpful/i,
  /leave feedback/i,
  /top guide sections/i,
  /up next:/i,
  /previous/i,
  /go to comments/i,
  /privacy policy/i,
  /terms of use/i,
];

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseIgnWikiLinks(raw, wikiSlug) {
  const found = new Set();
  const re = new RegExp(
    `https?://(?:www\\.)?ign\\.com/wikis/${escapeRe(wikiSlug)}/[A-Za-z0-9_%'(). -]+`,
    "gi",
  );
  for (const m of raw.matchAll(re)) {
    let url = m[0].replace(/[.,;:!?)\\]]+$/, "");
    try {
      const u = new URL(url);
      u.hostname = "www.ign.com";
      u.pathname = u.pathname.replace(/\/+$/, "") || "/";
      u.hash = "";
      u.search = "";
      if (/\/wikis\/[^/]+\/?$/.test(u.pathname)) continue;
      found.add(u.href);
    } catch {
      /* skip */
    }
  }
  return [...found].sort();
}

function parseIgnWalkthroughLinks(raw, walkthroughSlug) {
  const found = new Set();
  const re = new RegExp(
    `https?://(?:www\\.)?ign\\.com/walkthroughs/${escapeRe(walkthroughSlug)}[^\\s"'<>]*`,
    "gi",
  );
  for (const m of raw.matchAll(re)) {
    let url = m[0].replace(/[.,;:!?)\\]]+$/, "");
    try {
      const u = new URL(url);
      u.hostname = "www.ign.com";
      u.hash = "";
      found.add(u.href);
    } catch {
      /* skip */
    }
  }
  return [...found].sort();
}

async function tavilyExtract(url) {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) throw new Error("TAVILY_API_KEY missing");

  for (const extractDepth of ["basic", "advanced"]) {
    const res = await fetch("https://api.tavily.com/extract", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_key: apiKey, urls: [url], extract_depth: extractDepth }),
      signal: AbortSignal.timeout(120_000),
    });
    const data = await res.json();
    const results = data?.results ?? [];
    const hit = results.find((r) => r?.raw_content || r?.content) ?? results[0];
    const raw = hit?.raw_content || hit?.content || "";
    if (raw.length >= 60) {
      return { depth: extractDepth, chars: raw.length, content: raw, failed: data?.failed_results };
    }
  }
  return { depth: null, chars: 0, content: "", failed: true };
}

async function directFetch(url) {
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; GameGuideGo/1.0 research)",
        Accept: "text/html",
      },
      signal: AbortSignal.timeout(15_000),
      redirect: "follow",
    });
    const text = await res.text();
    return { status: res.status, chars: text.length, blocked: /cloudflare|cf-ray/i.test(text) };
  } catch (e) {
    return { status: 0, chars: 0, error: String(e) };
  }
}

function analyze(label, url, raw) {
  const cleaned = cleanSnippet(raw);
  const chunks = chunkGuideWithMeta(cleaned);
  const noiseHits = NOISE_PATTERNS.filter((p) => p.test(cleaned)).map((p) => String(p));
  const headings = [...cleaned.matchAll(/^#{1,3}\s+(.+)$/gm)].map((m) => m[1].slice(0, 70));
  const h2h3 = [...cleaned.matchAll(/^#{2,3}\s+(.+)$/gm)].map((m) => m[1].slice(0, 70));
  const linkCount = (raw.match(/https?:\/\//g) || []).length;
  const wikiLinks = parseIgnWikiLinks(raw, "pokemon-diamond-pearl-platinum-version");
  const wtLinks = parseIgnWalkthroughLinks(raw, "pokemon-diamond-version");

  console.log(`\n=== ${label} ===`);
  console.log(`URL: ${url}`);
  console.log(`raw: ${raw.length} chars | cleaned: ${cleaned.length} | chunks: ${chunks.length}`);
  console.log(`links in raw: ${linkCount} | wiki chapter links: ${wikiLinks.length} | walkthrough links: ${wtLinks.length}`);
  console.log(`noise patterns hit: ${noiseHits.length ? noiseHits.join(", ") : "(none)"}`);
  if (h2h3.length) console.log(`headings (sample): ${h2h3.slice(0, 8).join(" | ")}`);
  const sample = cleaned.slice(0, 400).replace(/\n/g, " ");
  console.log(`sample: ${sample}…`);

  return { cleaned, chunks, wikiLinks, wtLinks, raw };
}

async function main() {
  console.log("IGN guide pattern research\n");

  for (const [key, url] of Object.entries(URLS)) {
    const direct = await directFetch(url);
    console.log(`\n[direct fetch] ${key}: status=${direct.status} chars=${direct.chars}${direct.blocked ? " (cf?)" : ""}${direct.error ? ` err=${direct.error}` : ""}`);
  }

  const results = {};
  for (const [key, url] of Object.entries(URLS)) {
    const ex = await tavilyExtract(url);
    console.log(`\n[tavily] ${key}: depth=${ex.depth ?? "fail"} chars=${ex.chars}`);
    if (ex.chars < 60) {
      results[key] = null;
      continue;
    }
    results[key] = analyze(key, url, ex.content);
  }

  // Discovery from hub
  const hub = results.wikiHub;
  if (hub?.raw) {
    const links = parseIgnWikiLinks(hub.raw, "pokemon-diamond-pearl-platinum-version");
    console.log(`\n=== wiki hub discovery ===`);
    console.log(`unique chapter URLs from Walkthrough hub: ${links.length}`);
    console.log(`sample: ${links.slice(0, 12).join("\n  ")}`);
    if (links.length > 12) console.log(`  … +${links.length - 12} more`);
  }

  const chapter = results.wikiChapter;
  if (chapter?.raw) {
    const links = parseIgnWikiLinks(chapter.raw, "pokemon-diamond-pearl-platinum-version");
    console.log(`\n=== wiki chapter prev/next discovery ===`);
    console.log(`sibling links from chapter page: ${links.length}`);
    console.log(`sample: ${links.slice(0, 8).join("\n  ")}`);
  }

  const legacy = results.walkthroughsLegacy;
  if (legacy?.raw) {
    const links = parseIgnWalkthroughLinks(legacy.raw, "pokemon-diamond-version");
    console.log(`\n=== walkthroughs legacy discovery ===`);
    console.log(`walkthrough URLs: ${links.length}`);
    console.log(`sample: ${links.slice(0, 10).join("\n  ")}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
