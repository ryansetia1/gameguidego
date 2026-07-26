#!/usr/bin/env node
/**
 * Re-ingest guides with outline metadata (section_path / section_confidence).
 *
 * - http(s) guides: delete chunks → POST /api/guide-ingest (full re-embed with section prefix)
 * - upload:// guides: backfill metadata in-place (source files are not stored)
 *
 * Usage:
 *   node scripts/reingest-guide-outlines.mjs --all
 *   node scripts/reingest-guide-outlines.mjs <guide_url> [guide_url ...]
 *   node scripts/reingest-guide-outlines.mjs --all --base-url http://localhost:3000
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { sectionForSnippet } from "../lib/guide-outline.js";

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

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
if (!supabaseUrl || !supabaseKey) {
  console.error("Set NEXT_PUBLIC_SUPABASE_URL and a Supabase key in .env.local");
  process.exit(1);
}

const args = process.argv.slice(2);
const all = args.includes("--all");
const baseUrl =
  args.find((arg, i) => arg === "--base-url" && args[i + 1])?.length
    ? args[args.indexOf("--base-url") + 1]
    : process.env.REINGEST_BASE_URL || "http://localhost:3000";
const urls = args.filter((arg, i) => !arg.startsWith("--") && args[i - 1] !== "--base-url");

const supabase = createClient(supabaseUrl, supabaseKey);

let targets = urls;
if (all) {
  const { data, error } = await supabase.from("guide_chunks").select("guide_url");
  if (error) {
    console.error("Failed to list guide URLs:", error.message);
    process.exit(1);
  }
  targets = [...new Set((data ?? []).map((row) => String(row.guide_url ?? "")).filter(Boolean))];
}

if (!targets.length) {
  console.error("No guide URLs. Pass URLs or --all.");
  process.exit(1);
}

/** @param {string} guideUrl */
async function backfillUploadGuide(guideUrl) {
  const { data, error } = await supabase
    .from("guide_chunks")
    .select("id, chunk_index, chunk_text")
    .eq("guide_url", guideUrl)
    .order("chunk_index");
  if (error || !data?.length) {
    console.error(`backfill skip ${guideUrl}:`, error?.message || "no chunks");
    return;
  }

  const fullText = data.map((row) => String(row.chunk_text ?? "")).join("\n\n");
  let updated = 0;
  for (const row of data) {
    const chunkText = String(row.chunk_text ?? "");
    const section = sectionForSnippet(fullText, chunkText);
    const { error: updateError } = await supabase
      .from("guide_chunks")
      .update({
        section_path: section.path,
        section_confidence: section.confidence,
      })
      .eq("id", row.id);
    if (!updateError) updated += 1;
  }
  console.log(`backfill ok ${guideUrl} (${updated}/${data.length} chunks, embed unchanged)`);
}

/** @param {string} guideUrl */
async function reingestRemoteGuide(guideUrl) {
  const { error: delError } = await supabase.from("guide_chunks").delete().eq("guide_url", guideUrl);
  if (delError) {
    console.error(`delete failed ${guideUrl}:`, delError.message);
    return;
  }

  const res = await fetch(`${baseUrl.replace(/\/$/, "")}/api/guide-ingest`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ preferredUrls: [guideUrl] }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error(`ingest failed ${guideUrl}: HTTP ${res.status}`, body);
    return;
  }

  const row = Array.isArray(body.results) ? body.results[0] : null;
  const indexed = row?.indexed ?? body.indexed;
  const chunkCount = row?.chunkCount ?? 0;
  console.log(
    `${indexed ? "ingest ok" : "ingest miss"} ${guideUrl} chunks=${chunkCount}${row?.hubWarning ? " hubWarning" : ""}${row?.isBlocked ? " blocked" : ""}`,
  );
}

console.log(`Re-ingesting ${targets.length} guide(s) via ${baseUrl} ...`);

for (const guideUrl of targets) {
  if (guideUrl.startsWith("upload://")) {
    await backfillUploadGuide(guideUrl);
  } else {
    await reingestRemoteGuide(guideUrl);
  }
}

const { count: withMeta } = await supabase
  .from("guide_chunks")
  .select("*", { count: "exact", head: true })
  .not("section_confidence", "is", null);

const { count: total } = await supabase
  .from("guide_chunks")
  .select("*", { count: "exact", head: true });

console.log(`Done. chunks with section_confidence: ${withMeta ?? 0}/${total ?? 0}`);
