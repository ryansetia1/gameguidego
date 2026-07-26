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

const SEED_URLS = [
  "https://www.neoseeker.com/hades-2020/walkthrough",
  "https://www.neoseeker.com/hades-2020/Beginner%27s_Guide",
  "https://www.neoseeker.com/hades-2020/Zeus",
];

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function discoverFromText(text, gameSlug) {
  const re = new RegExp(
    `https?://(?:www\\.)?neoseeker\\.com/${escapeRe(gameSlug)}/[^\\s"'\\])>]+`,
    "gi",
  );
  const found = new Set();
  for (const m of text.matchAll(re)) {
    let url = m[0].replace(/[.,;:!?)\\]]+$/, "");
    try {
      const u = new URL(url);
      u.hostname = "www.neoseeker.com";
      u.pathname = u.pathname.replace(/\/+$/, "") || "/";
      u.hash = "";
      if (!u.pathname.includes("/Special:")) found.add(u.toString());
    } catch {
      /* skip */
    }
  }
  return [...found].sort();
}

function discoverFromHtml(html, gameSlug) {
  const re = new RegExp(`href="(/${escapeRe(gameSlug)}/[^"#]+)"`, "gi");
  const found = new Set();
  for (const m of html.matchAll(re)) {
    const path = m[1].replace(/\/+$/, "");
    if (path.includes("/Special:")) continue;
    found.add(`https://www.neoseeker.com${path}`);
  }
  return [...found].sort();
}

async function tavilyRaw(url) {
  const res = await fetch("https://api.tavily.com/extract", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: process.env.TAVILY_API_KEY,
      urls: [url],
      extract_depth: "basic",
    }),
    signal: AbortSignal.timeout(120_000),
  });
  const data = await res.json();
  return data?.results?.[0]?.raw_content || "";
}

async function fetchHtml(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": "GameGuideGo/1.0 (guide-ingest-test)" },
    signal: AbortSignal.timeout(30_000),
  });
  return res.ok ? await res.text() : "";
}

for (const seed of SEED_URLS) {
  const slug = seed.match(/neoseeker\.com\/([^/]+)/)[1];
  console.log(`\n=== SEED: ${seed.split("/").pop()} ===`);
  const [raw, html] = await Promise.all([tavilyRaw(seed), fetchHtml(seed)]);
  const fromRaw = discoverFromText(raw, slug);
  const fromHtml = discoverFromHtml(html, slug);
  const navBlock =
    html.match(/id="wiki-navigation"[\s\S]{0,15000}?<\/div>\s*<\/div>/i)?.[0] || "";
  const fromNav = discoverFromHtml(navBlock, slug);

  console.log("Tavily raw links:", fromRaw.length);
  console.log("Full HTML links:", fromHtml.length);
  console.log("Sidebar #wiki-navigation only:", fromNav.length);
  console.log(
    "Nav sample:",
    fromNav.slice(0, 8).map((u) => u.split("/").pop()).join(", "),
  );

  const onlyInNav = fromNav.filter((u) => !fromRaw.includes(u));
  console.log("In sidebar but NOT in Tavily raw:", onlyInNav.length);
  if (onlyInNav.length && onlyInNav.length <= 10) {
    console.log("  missing:", onlyInNav.map((u) => u.split("/").pop()).join(", "));
  }

  // Compare seeds
  if (seed.includes("walkthrough")) {
    globalThis._hubNav = fromNav;
  }
}

if (globalThis._hubNav) {
  for (const seed of SEED_URLS.slice(1)) {
    const slug = seed.match(/neoseeker\.com\/([^/]+)/)[1];
    const html = await fetchHtml(seed);
    const navBlock =
      html.match(/id="wiki-navigation"[\s\S]{0,15000}?<\/div>\s*<\/div>/i)?.[0] || "";
    const fromNav = discoverFromHtml(navBlock, slug);
    const same =
      fromNav.length === globalThis._hubNav.length &&
      fromNav.every((u, i) => u === globalThis._hubNav[i]);
    console.log(`\n${seed.split("/").pop()} sidebar === hub sidebar? ${same} (${fromNav.length} links)`);
  }
}
