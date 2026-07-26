#!/usr/bin/env node
/**
 * Neoseeker guide smoke test — extract, ingest, discovery, chunk quality.
 * Usage: node scripts/test-neoseeker.mjs [--base-url http://localhost:3000]
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

const BASE = process.argv.includes("--base-url")
  ? process.argv[process.argv.indexOf("--base-url") + 1]
  : "http://localhost:3000";

const URLS = {
  hub: "https://www.neoseeker.com/hades-2020/walkthrough",
  beginner: "https://www.neoseeker.com/hades-2020/Beginner%27s_Guide",
  tartarus: "https://www.neoseeker.com/hades-2020/Tartarus",
  zeus: "https://www.neoseeker.com/hades-2020/Zeus",
};

const NOISE_PATTERNS = [
  /neoseeker/i,
  /sign in/i,
  /cookie/i,
  /advertis/i,
  /support neoseeker/i,
  /table of contents/i,
  /prev.*next/i,
  /post in our forum/i,
];

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

function analyzeExtract(label, url, raw) {
  const cleaned = cleanSnippet(raw);
  const chunks = chunkGuideWithMeta(cleaned);
  const noiseHits = NOISE_PATTERNS.filter((p) => p.test(cleaned)).map((p) => String(p));
  const headings = [...cleaned.matchAll(/^#{1,3}\s+(.+)$/gm)].map((m) => m[1].slice(0, 60));
  const hasTable = /\|.+\|/.test(cleaned) || /wikitable/i.test(raw);
  const linkCount = (cleaned.match(/https?:\/\//g) || []).length;
  const neoseekerLinks = (cleaned.match(/neoseeker\.com/gi) || []).length;

  return {
    label,
    url,
    rawChars: raw.length,
    cleanedChars: cleaned.length,
    chunkCount: chunks.length,
    avgChunkChars: chunks.length
      ? Math.round(chunks.reduce((s, c) => s + c.text.length, 0) / chunks.length)
      : 0,
    headings: headings.slice(0, 8),
    hasTable,
    linkCount,
    neoseekerLinks,
    noiseHits,
    preview: cleaned.slice(0, 280).replace(/\s+/g, " "),
    tail: cleaned.slice(-200).replace(/\s+/g, " "),
    sectionsWithPath: chunks.filter((c) => c.section_path).length,
  };
}

async function testDiscovery() {
  const q = encodeURIComponent("Hades beginner guide neoseeker");
  const res = await fetch(`${BASE}/api/guide-search?game=Hades&platform=PC&q=${q}`, {
    signal: AbortSignal.timeout(30_000),
  });
  const data = await res.json();
  const neo = (data.results || []).filter((r) => /neoseeker/i.test(r.url));
  return { status: res.status, available: data.available, total: data.results?.length ?? 0, neo };
}

async function testIngest(url) {
  const res = await fetch(`${BASE}/api/guide-ingest`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ urls: [url], game: "Hades", platform: "PC" }),
    signal: AbortSignal.timeout(300_000),
  });
  return { status: res.status, body: await res.json() };
}

async function testIndexed(url) {
  const res = await fetch(`${BASE}/api/guide-ingest?url=${encodeURIComponent(url)}`, {
    signal: AbortSignal.timeout(15_000),
  });
  return res.json();
}

async function main() {
  console.log("=== Neoseeker Hades Guide Test ===\n");
  console.log(`Base URL: ${BASE}`);
  console.log(`Tavily key: ${process.env.TAVILY_API_KEY ? "set" : "MISSING"}`);
  console.log(`RAG infra: ${process.env.SUMOPOD_API_KEY && process.env.NEXT_PUBLIC_SUPABASE_URL ? "set" : "partial/missing"}\n`);

  // 1. Discovery
  console.log("--- 1. Guide search discovery ---");
  try {
    const disc = await testDiscovery();
    console.log(JSON.stringify(disc, null, 2));
  } catch (e) {
    console.log("FAIL:", e.message);
  }

  // 2. Tavily extract all URLs
  console.log("\n--- 2. Tavily extract (per page) ---");
  const extracts = {};
  for (const [key, url] of Object.entries(URLS)) {
    process.stdout.write(`  ${key}... `);
    try {
      const ex = await tavilyExtract(url);
      extracts[key] = ex;
      console.log(`${ex.depth} → ${ex.chars} chars`);
    } catch (e) {
      extracts[key] = { error: e.message };
      console.log(`ERROR: ${e.message}`);
    }
  }

  const analyses = [];
  for (const [key, ex] of Object.entries(extracts)) {
    if (!ex.content) {
      analyses.push({ label: key, url: URLS[key], error: ex.error || "empty extract" });
      continue;
    }
    analyses.push(analyzeExtract(key, URLS[key], ex.content));
  }
  console.log("\nExtract analysis:");
  for (const a of analyses) {
    console.log(`\n[${a.label}] ${a.url}`);
    if (a.error) {
      console.log(`  ERROR: ${a.error}`);
      continue;
    }
    console.log(`  raw=${a.rawChars} cleaned=${a.cleanedChars} chunks=${a.chunkCount} avgChunk=${a.avgChunkChars}`);
    console.log(`  headings: ${a.headings.join(" | ") || "(none)"}`);
    console.log(`  table=${a.hasTable} links=${a.linkCount} neoseekerLinks=${a.neoseekerLinks} outlineChunks=${a.sectionsWithPath}`);
    console.log(`  noise: ${a.noiseHits.length ? a.noiseHits.join(", ") : "none"}`);
    console.log(`  preview: ${a.preview}...`);
  }

  // 3. Ingest Beginner's Guide (main test page)
  console.log("\n--- 3. Ingest API (Beginner's Guide) ---");
  try {
    const ing = await testIngest(URLS.beginner);
    console.log(JSON.stringify(ing, null, 2));
    const idx = await testIndexed(URLS.beginner);
    console.log("Indexed check:", JSON.stringify(idx));
  } catch (e) {
    console.log("FAIL:", e.message);
  }

  // 4. Hub page ingest (should warn or index thin content)
  console.log("\n--- 4. Ingest API (hub /walkthrough) ---");
  try {
    const ing = await testIngest(URLS.hub);
    console.log(JSON.stringify(ing, null, 2));
  } catch (e) {
    console.log("FAIL:", e.message);
  }

  // 5. Summary verdict
  console.log("\n=== VERDICT ===");
  const beginner = analyses.find((a) => a.label === "beginner");
  const hub = analyses.find((a) => a.label === "hub");
  const tartarus = analyses.find((a) => a.label === "tartarus");

  if (beginner && !beginner.error && beginner.cleanedChars >= 400) {
    console.log("✓ Beginner's Guide extractable and chunkable");
  } else {
    console.log("✗ Beginner's Guide extract failed or too short");
  }
  if (hub && !hub.error) {
    const mostlyLinks = hub.neoseekerLinks > 15 && hub.cleanedChars < 8000;
    console.log(mostlyLinks ? "⚠ Hub page is mostly link index (expected)" : "? Hub page has substantive content");
  }
  if (tartarus && !tartarus.error && tartarus.cleanedChars > (beginner?.cleanedChars || 0)) {
    console.log("✓ Biome pages likely richer than beginner guide");
  }
  console.log("\nDone.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
