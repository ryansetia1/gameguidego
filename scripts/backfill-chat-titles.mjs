/**
 * Backfill empty chats.title from the first user message in messages cache.
 * Usage: node scripts/backfill-chat-titles.mjs
 * Requires NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in env.
 */
import { createClient } from "@supabase/supabase-js";
import { titleFromMessages } from "../lib/topic-title.js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const supabase = createClient(url, key);
const { data, error } = await supabase
  .from("chats")
  .select("id, title, messages")
  .eq("title", "");
if (error) throw error;

let updated = 0;
for (const row of data ?? []) {
  const title = titleFromMessages(row.messages);
  if (!title) continue;
  const { error: upErr } = await supabase.from("chats").update({ title }).eq("id", row.id);
  if (upErr) throw upErr;
  updated++;
}
console.log(`Backfilled ${updated} topic title(s).`);
