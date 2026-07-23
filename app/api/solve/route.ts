import { NextResponse } from "next/server";
import { after } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import {
  buildAssistantVariantBody,
  mergeAssistantIntoMessages,
} from "@/lib/chat-persist.js";
import { persistAssistantResponse, loadMessagesForServerMerge } from "@/lib/chat-thread-persist.js";
import { getCachedSearch, setCachedSearch } from "@/lib/search-cache";
import { censorSpoilers, resolveQuestion, summarize, type Turn } from "@/lib/replicate";
import { guideIngestHint } from "@/lib/guide-hints.js";
import { coerceGuideUrlsFromBody } from "@/lib/guide-urls.js";
import { coerceBundlePrefsFromBody } from "@/lib/bundle-prefs.js";
import { retrieveFromPreferredGuides } from "@/lib/guide-rag";
import { coerceSpoilerPrefs } from "@/lib/spoiler-prefs";
import { coerceDisplayName } from "@/lib/profile.js";
import {
  bumpPlayerMemoryCount,
  createAuthedSupabase,
  loadMemoryForSolve,
  refreshPlayerMemory,
} from "@/lib/player-memory-server";
import { searchGuides, type SearchResult } from "@/lib/tavily";
import { logSolveJourneyToDb, sourcesForSolveLog, type SolveJourneyEntry } from "@/lib/solve-log";
import { runWithTrace, logTraceEvent } from "@/lib/trace";

export const runtime = "nodejs";

const MAX_HISTORY = 10;

function cleanText(value: unknown, maxLength: number): string {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim().slice(0, maxLength);
}

// Accept only well-formed http(s) URLs for the optional preferred guide.
function cleanUrl(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim().slice(0, 300);
  if (!trimmed) return "";
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    return url.toString();
  } catch {
    return "";
  }
}

// llm_calls.user_id has an FK to auth.users; a garbage value would fail the
// insert, so accept only a well-formed UUID (else null).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function cleanUuid(value: unknown): string | null {
  return typeof value === "string" && UUID_RE.test(value) ? value : null;
}

const MAX_IMAGES = 10;

// Accept up to 10 well-formed http(s) image URLs or base64 data URIs.
function cleanImageUrl(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("data:image/")) {
    return trimmed.slice(0, 15_000_000); // Allow large base64 strings
  }
  try {
    const url = new URL(trimmed.slice(0, 1000));
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    return url.toString();
  } catch {
    return "";
  }
}

function parseImages(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .flatMap((item): string[] => {
      const url = cleanImageUrl(item);
      return url ? [url] : [];
    })
    .slice(0, MAX_IMAGES);
}

function parseHistory(value: unknown): Turn[] {
  if (!Array.isArray(value)) return [];

  return value
    .flatMap((item): Turn[] => {
      if (!item || typeof item !== "object") return [];
      const role = "role" in item ? item.role : undefined;
      const content = "content" in item ? item.content : undefined;
      if (role !== "user" && role !== "assistant") return [];
      const text = cleanText(content, 800);
      if (!text) return [];
      return [{ role, content: text }];
    })
    .slice(-MAX_HISTORY);
}

async function tieredWebSearch(
  searchQuery: string,
  signal?: AbortSignal,
): Promise<SearchResult[]> {
  const cacheKey = `${searchQuery}::web`;
  const cached = await getCachedSearch(cacheKey);
  if (Array.isArray(cached)) return cached as SearchResult[];

  try {
    const results = await searchGuides(searchQuery, signal);
    void setCachedSearch(cacheKey, results);
    return results;
  } catch (searchError) {
    console.error("Search failed, continuing without sources:", searchError);
    return [];
  }
}

export async function POST(request: Request) {
  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Could not read the request." },
      { status: 400 },
    );
  }

  const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const question = cleanText(record.question, 2000);
  const game = cleanText(record.game, 120);
  const platform = cleanText(record.platform, 40);
  const preferredUrls = coerceGuideUrlsFromBody(record);
  const history = parseHistory(record.history);
  const images = parseImages(record.images);
  const spoilerPrefs = coerceSpoilerPrefs(record.spoilerPrefs);
  const playerName = coerceDisplayName(record.playerName);
  const userId = cleanUuid(record.userId);
  const bundlePrefs = coerceBundlePrefsFromBody(record.bundlePrefs);
  const chatId = cleanUuid(record.chatId);
  const authHeader = request.headers.get("Authorization");
  const retryContext = record.retryContext as {
    searchTopic?: string;
    sources?: SearchResult[];
    pipelineType?: string;
    guideHint?: string;
  } | undefined;
  // We explicitly IGNORE request.signal so the AI continues running if the connection drops.

  if (question.length < 2) {
    return NextResponse.json(
      { error: "Please type your question first." },
      { status: 400 },
    );
  }

  if (!process.env.REPLICATE_API_TOKEN) {
    return NextResponse.json(
      { error: "The server is missing a required API key." },
      { status: 503 },
    );
  }

  const stream = new ReadableStream({
    start(controller) {
      const sendEvent = (event: string, data: any) => {
        try {
          const text = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
          controller.enqueue(new TextEncoder().encode(text));
        } catch (e) {
          // Ignore stream errors (client disconnected)
        }
      };

      const traceId = request.headers.get("X-Trace-Id") || crypto.randomUUID();
      sendEvent("prediction_id", { id: traceId }); // Send traceId early for debug if needed

      const backgroundTask = runWithTrace(traceId, async () => {
        const startedAt = Date.now();
        const isRetry = Boolean(retryContext);
        let playerMemory = null;
        let authedSupabase = null;

        if (authHeader && userId) {
          authedSupabase = createAuthedSupabase(authHeader.replace(/^Bearer\s+/i, ""));
          if (authedSupabase) {
            try {
              playerMemory = await loadMemoryForSolve(authedSupabase, userId, game, platform);
            } catch (memoryError) {
              console.error("Player memory load failed (continuing):", memoryError);
            }
          }
        }

        await logTraceEvent("solve_start", "Started solve generation", undefined, {
          question,
          game,
          platform,
          userId,
          playerName,
        });
        try {
          let sources: SearchResult[] = [];
          let guideHint: string | undefined;

        let rewriteLatencyMs = 0;
        let retrievalLatencyMs = 0;
        let generationLatencyMs = 0;
        let pipelineType: SolveJourneyEntry["pipelineType"] = "knowledge_only";
        let finalAnswer = "";
        let finalSources: any[] = [];

        sendEvent("status", { text: "Understanding your question..." });
        const rewriteStart = Date.now();
        const forRag = preferredUrls.length > 0;
        // images are part of the query context now (vision-aware rewrite), so they
        // must key the cache too — else a text-only query gets served for a screenshot.
        const rawInputs = JSON.stringify({ question, history, game, platform, forRag, images });
        const rewriteCacheKey = `rewrite::${createHash("sha256").update(rawInputs).digest("hex")}`;

        let searchTopic = retryContext?.searchTopic || (await getCachedSearch(rewriteCacheKey)) as string | null;
        if (typeof searchTopic !== "string") {
          // Fix A: on image turns, drop prior Guide (assistant) turns from the
          // rewrite's history. A past answer's character ID poisons "ini"/"this"
          // follow-ups (trace 192da351 → d1c3401f: rewrite inherited a wrong GF
          // name). The current image is the source of truth; user turns stay for
          // topical context. summarize still gets full history + the trust-image
          // guard, so multi-turn continuity is preserved there.
          const rewriteHistory = images.length
            ? history.filter((turn) => turn.role === "user")
            : history;
          searchTopic = await resolveQuestion({
            question,
            history: rewriteHistory,
            game,
            platform,
            userId,
            images,
            forRag,
          });
          void setCachedSearch(rewriteCacheKey, searchTopic);
        }

        rewriteLatencyMs = Date.now() - rewriteStart;
        await logTraceEvent("rewrite_complete", "Resolved question into search topic", rewriteLatencyMs, { searchTopic });

        const hasSearchProvider = Boolean(
          process.env.TAVILY_API_KEY || process.env.SERPER_API_KEY,
        );
        const searchQuery = [game, platform, searchTopic, "walkthrough guide"]
          .filter(Boolean)
          .join(" ");

        const retrievalStart = Date.now();
        if (retryContext?.sources) {
          sources = retryContext.sources;
          pipelineType = retryContext.pipelineType as SolveJourneyEntry["pipelineType"] || "knowledge_only";
          guideHint = retryContext.guideHint;
        } else if (preferredUrls.length) {
          sendEvent("status", { text: "Searching your guide..." });
          const rag = await retrieveFromPreferredGuides({
            guideUrls: preferredUrls,
            query: searchTopic,
            game,
            platform,
            userId,
            bundlePrefs,
          });

          if (rag?.hubWarning && rag.indexedCount === 0) {
            guideHint = guideIngestHint({ hubWarning: true }) ?? undefined;
          } else if (rag && rag.indexedCount < rag.totalGuides) {
            guideHint =
              guideIngestHint({
                available: true,
                indexedCount: rag.indexedCount,
                total: rag.totalGuides,
              }) ?? undefined;
          } else if (rag && !rag.skipWebSearch && !rag.sources.length) {
            guideHint =
              guideIngestHint({ available: true, indexed: false }) ?? undefined;
          }

          if (rag?.skipWebSearch) {
            sources = rag.sources;
            pipelineType = "rag";
          } else if (rag) {
            if (hasSearchProvider) {
              sendEvent("status", { text: "Searching the web..." });
            }
            const web = hasSearchProvider
              ? await tieredWebSearch(searchQuery)
              : [];
            sources = [...rag.sources, ...web];
            pipelineType = web.length > 0 ? "fallback_web" : (rag.sources.length > 0 ? "rag" : "knowledge_only");
          } else if (hasSearchProvider) {
            sendEvent("status", { text: "Searching the web..." });
            pipelineType = "fallback_web";
            void logTraceEvent("web_search_start", "Starting tiered web search");
            sources = await tieredWebSearch(searchQuery);
            void logTraceEvent("web_search_complete", "Finished tiered web search", Date.now() - retrievalStart, { sourceCount: sources.length });
          }
        } else if (hasSearchProvider) {
          pipelineType = "web";
          sendEvent("status", { text: "Searching the web..." });
          void logTraceEvent("web_search_start", "Starting tiered web search");
          sources = await tieredWebSearch(searchQuery);
          if (sources.length === 0) {
            pipelineType = "knowledge_only";
          }
          void logTraceEvent("web_search_complete", "Finished tiered web search", Date.now() - retrievalStart, { sourceCount: sources.length });
        }
        
        if (pipelineType === "knowledge_only") {
          guideHint = "Couldn't find on the web, answering from knowledge";
        }

        retrievalLatencyMs = Date.now() - retrievalStart;

        // Emit context so frontend can cache it for potential retry
        sendEvent("context_ready", {
          searchTopic,
          sources,
          pipelineType,
          guideHint
        });

        await logTraceEvent("retrieval_complete", "Finished gathering sources", retrievalLatencyMs, {
          sourceCount: sources.length,
          pipelineType,
          webSources: sources
            .filter((s) => !s.preferred)
            .map((s) => ({
              title: s.title,
              url: s.url,
              score: s.score,
              preview: s.content?.slice(0, 600) ?? "",
            })),
          ragChunks: sources
            .filter((s) => s.preferred)
            .map((s) => ({
              title: s.title,
              url: s.url,
              similarity: s.score,
              preview: s.content?.slice(0, 600) ?? "",
            })),
        });

        sendEvent("status", { text: "Reading and building answer..." });
        const generationStart = Date.now();
        let { answer, highlights, spoilers, spoilerRisk } = await summarize({
          game,
          platform,
          question,
          sources,
          history,
          images,
          imageResolvedSubject: images.length ? searchTopic : undefined,
          spoilerPrefs,
          playerName,
          playerMemory,
          userId,
          onProgress: (msg: string, id?: string) => {
            if (id) sendEvent("prediction_id", { id });
            sendEvent("status", { text: msg });
          },
        });

        if (!spoilerPrefs.major && spoilerRisk) {
          const censorStart = Date.now();
          const cleaned = await censorSpoilers({
            answer,
            highlights,
            game,
            platform,
            userId,
          });
          const censorLatencyMs = Date.now() - censorStart;
          await logTraceEvent("censor_complete", `Spoilers censored in ${censorLatencyMs}ms`, censorLatencyMs, { spoilerRisk: true, wasCensored: !!cleaned });
          
          if (cleaned) {
            answer = cleaned.answer;
            highlights = cleaned.highlights;
          } else {
            // Censor failed / returned nothing usable. Never fall back to the
            // original — it holds the spoiler. Neutral redirect, no "spoiler" word.
            // ponytail: one English line; per-language fallback would need another
            // LLM call, and this only fires when the censor call itself failed.
            answer =
              "Let's keep that one a surprise. Ask what to do next and I'll help you get there.";
            highlights = [];
          }
        }

        generationLatencyMs = Date.now() - generationStart;
        await logTraceEvent("generation_complete", `Answer generated in ${generationLatencyMs}ms`, generationLatencyMs, { pipelineType, sourceCount: sources.length });
        finalAnswer = answer;
        // Dedupe by URL so multiple RAG chunks from the same page don't render as
        // "(section 1)"/"(section 2)" links that all open the exact same URL.
        const adminLogSources = sourcesForSolveLog(sources);
        finalSources = adminLogSources.map(({ title, url }) => ({ title, url }));

        sendEvent("result", {
          answer,
          highlights,
          spoilers: spoilerPrefs.major ? spoilers : [],
          sources: finalSources,
          pipelineType,
          ...(guideHint ? { guideHint } : {}),
        });
        
        // Save to Supabase since we are generating in detached mode!
        if (chatId && authHeader) {
          try {
            const supabase = createClient(
              process.env.NEXT_PUBLIC_SUPABASE_URL!,
              process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
              { global: { headers: { Authorization: authHeader } } },
            );
            const messages = await loadMessagesForServerMerge(supabase, chatId);
            if (messages.length) {
              const variantBody = buildAssistantVariantBody({
                content: finalAnswer,
                sources: finalSources,
                highlights,
                spoilers,
                pipelineType,
                spoilerMajor: spoilerPrefs.major,
              });

              if (mergeAssistantIntoMessages(messages, variantBody)) {
                const persisted = await persistAssistantResponse(supabase, {
                  chatId,
                  messages,
                  variantBody,
                  traceId,
                });
                if (!persisted.ok) {
                  console.warn("[chat-thread] Normalized persist failed, using legacy cache", {
                    chatId,
                    traceId,
                    reason: "reason" in persisted ? persisted.reason : "unknown",
                  });
                  await supabase
                    .from("chats")
                    .update({ messages, updated_at: new Date().toISOString() })
                    .eq("id", chatId);
                }
              } else {
                const last = messages.at(-1);
                console.warn("[chat-persist] Server merge skipped", {
                  chatId,
                  traceId,
                  messageCount: messages.length,
                  lastRole: last?.role,
                  lastContent:
                    typeof last?.content === "string"
                      ? last.content.slice(0, 48)
                      : undefined,
                });
              }
            } else {
              console.warn("[chat-thread] No messages for background save", {
                chatId,
                traceId,
              });
            }
          } catch (err) {
            console.error("Failed to save background chat to Supabase:", err);
          }
        }
        
        // Non-blocking log
        logSolveJourneyToDb({
          userId,
          playerName,
          traceId,
          game,
          platform,
          question,
          preferredUrls,
          pipelineType,
          rewriteLatencyMs,
          retrievalLatencyMs,
          generationLatencyMs,
          totalLatencyMs: Date.now() - startedAt,
          status: "success",
          answer: finalAnswer,
          sources: adminLogSources,
        }).catch(console.error);

        if (authedSupabase && userId && !isRetry) {
          after(async () => {
            try {
              const bump = await bumpPlayerMemoryCount(authedSupabase!, userId);
              if (!bump) return;
              if (bump.hitDraft || bump.hitFull) {
                await refreshPlayerMemory(authedSupabase!, userId, { manual: false, force: true });
              }
            } catch (memoryBumpError) {
              console.error("Player memory bump failed:", memoryBumpError);
            }
          });
        }
      } catch (error) {
        console.error("Guide generation failed:", error);
        const timedOut =
          error instanceof Error &&
          (error.name === "AbortError" || error.name === "TimeoutError");

        sendEvent("error", {
          error: timedOut
            ? "The search took too long. Please try again."
            : "Couldn't build a guide. Please try again shortly.",
        });
        
        // Non-blocking log
        logSolveJourneyToDb({
          userId,
          playerName,
          traceId,
          game,
          platform,
          question,
          preferredUrls,
          pipelineType: "knowledge_only", // Default fallback if failed early
          totalLatencyMs: Date.now() - startedAt,
          status: "error",
          errorMessage: error instanceof Error ? error.message : String(error),
        }).catch(console.error);
      } finally {
        try { controller.close() } catch (e) {}
      }
      });

    after(() => backgroundTask);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    },
  });
}
