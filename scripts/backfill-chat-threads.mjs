import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import {
  backfillChatFromMessages,
  verifyChatThread,
} from "../lib/chat-thread-persist.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = join(__dirname, "../.env.local");

/** @param {string} key */
function getEnv(key) {
  try {
    const env = readFileSync(envPath, "utf8");
    const match = env.match(new RegExp(`^${key}=(.*)$`, "m"));
    return match ? match[1].replace(/['"]/g, "") : null;
  } catch {
    return process.env[key] ?? null;
  }
}

const supabaseUrl = getEnv("NEXT_PUBLIC_SUPABASE_URL");
const supabaseKey = getEnv("SUPABASE_SERVICE_ROLE_KEY");

if (!supabaseUrl || !supabaseKey) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const verifyOnly = args.includes("--verify");
const repairCache = args.includes("--repair-cache");
const chatIdArg = args.find((arg) => arg.startsWith("--chat-id="));
const chatIdFilter = chatIdArg ? chatIdArg.split("=")[1] : null;

async function loadChats() {
  let query = supabase.from("chats").select("id, messages, game, updated_at").order("updated_at", {
    ascending: false,
  });
  if (chatIdFilter) {
    query = query.eq("id", chatIdFilter);
  }
  const { data, error } = await query;
  if (error) throw error;
  return data ?? [];
}

/** @typedef {{ id: string; messages?: unknown; game?: string; updated_at?: string }} ChatRow */

/** @param {ChatRow[]} chats */
async function runVerify(chats) {
  let mismatches = 0;
  let empty = 0;

  for (const chat of chats) {
    const result = await verifyChatThread(supabase, chat);
    if (!result.legacyTurns && !result.normalizedTurns) {
      empty++;
      continue;
    }
    if (!result.match) {
      mismatches++;
      console.log("MISMATCH", result.chatId, result.issues.join(", "));
    }
  }

  console.log(
    `Verify complete: ${chats.length} chats, ${mismatches} mismatches, ${empty} empty.`,
  );
  return mismatches;
}

/** @param {ChatRow[]} chats */
async function runBackfill(chats) {
  let ok = 0;
  let skipped = 0;
  let failed = 0;

  for (const chat of chats) {
    const result = await backfillChatFromMessages(supabase, chat.id, chat.messages, {
      dryRun,
      repairCache,
    });

    if (!result.ok) {
      failed++;
      console.log("FAIL", chat.id, result.reason ?? "unknown");
      continue;
    }

    if (result.dryRun) {
      if (result.turnCount === 0) {
        skipped++;
        continue;
      }
      console.log(
        `DRY-RUN ${chat.id} (${chat.game ?? "game"}): ${result.turnCount} turns, ${result.messageCount} messages`,
      );
      ok++;
      continue;
    }

    if (result.turnCount === 0) {
      skipped++;
      continue;
    }

    console.log(
      `OK ${chat.id} (${chat.game ?? "game"}): ${result.turnCount} turns synced${repairCache ? ", cache repaired" : ""}`,
    );
    ok++;
  }

  console.log(
    `${dryRun ? "Dry-run" : "Backfill"} complete: ${ok} processed, ${skipped} skipped, ${failed} failed.`,
  );
  return failed;
}

async function main() {
  const chats = await loadChats();
  if (!chats.length) {
    console.log("No chats found.");
    return;
  }

  console.log(`Loaded ${chats.length} chat(s).`);

  if (verifyOnly) {
    const mismatches = await runVerify(chats);
    process.exit(mismatches > 0 ? 1 : 0);
  }

  const failed = await runBackfill(chats);
  if (!dryRun && failed === 0) {
    const mismatches = await runVerify(chats);
    process.exit(mismatches > 0 ? 1 : 0);
  }
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
