import { NextResponse } from "next/server";

import { getCachedSearch, setCachedSearch } from "@/lib/search-cache";
import { censorSpoilers, resolveQuestion, summarize, type Turn } from "@/lib/replicate";
import { guideIngestHint } from "@/lib/guide-hints.js";
import { coerceGuideUrlsFromBody } from "@/lib/guide-urls.js";
import { coerceBundlePrefsFromBody } from "@/lib/bundle-prefs.js";
import { retrieveFromPreferredGuides } from "@/lib/guide-rag";
import { coerceSpoilerPrefs } from "@/lib/spoiler-prefs";
import { coerceDisplayName } from "@/lib/profile.js";
import { searchGuides, type SearchResult } from "@/lib/tavily";

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

// Accept up to 10 well-formed http(s) image URLs (Supabase Storage public URLs).
function parseImages(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .flatMap((item): string[] => {
      const url = cleanUrl(item);
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
  signal: AbortSignal,
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
  const question = cleanText(record.question, 300);
  const game = cleanText(record.game, 120);
  const platform = cleanText(record.platform, 40);
  const preferredUrls = coerceGuideUrlsFromBody(record);
  const history = parseHistory(record.history);
  const images = parseImages(record.images);
  const spoilerPrefs = coerceSpoilerPrefs(record.spoilerPrefs);
  const playerName = coerceDisplayName(record.playerName);
  const userId = cleanUuid(record.userId);
  const bundlePrefs = coerceBundlePrefsFromBody(record.bundlePrefs);
  const signal = request.signal;

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
    async start(controller) {
      const sendEvent = (event: string, data: any) => {
        const text = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
        controller.enqueue(new TextEncoder().encode(text));
      };

      try {
        let sources: SearchResult[] = [];
        let guideHint: string | undefined;

        sendEvent("status", { text: "Understanding your question..." });
        const searchTopic = await resolveQuestion({
          question,
          history,
          game,
          platform,
          userId,
          signal,
          forRag: preferredUrls.length > 0,
        });

        const hasSearchProvider = Boolean(
          process.env.TAVILY_API_KEY || process.env.SERPER_API_KEY,
        );
        const searchQuery = [game, platform, searchTopic, "walkthrough guide"]
          .filter(Boolean)
          .join(" ");

        if (preferredUrls.length) {
          sendEvent("status", { text: "Searching your guide..." });
          const rag = await retrieveFromPreferredGuides({
            guideUrls: preferredUrls,
            query: searchTopic,
            signal,
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
          } else if (rag) {
            if (hasSearchProvider) {
              sendEvent("status", { text: "Searching the web..." });
            }
            const web = hasSearchProvider
              ? await tieredWebSearch(searchQuery, signal)
              : [];
            sources = [...rag.sources, ...web];
          } else if (hasSearchProvider) {
            sendEvent("status", { text: "Searching the web..." });
            sources = await tieredWebSearch(searchQuery, signal);
          }
        } else if (hasSearchProvider) {
          sendEvent("status", { text: "Searching the web..." });
          sources = await tieredWebSearch(searchQuery, signal);
        }

        sendEvent("status", { text: "Reading and building answer..." });
        let { answer, highlights, spoilers, spoilerRisk } = await summarize({
          game,
          platform,
          question,
          sources,
          history,
          images,
          spoilerPrefs,
          playerName,
          userId,
          signal,
        });

        if (!spoilerPrefs.major && spoilerRisk) {
          sendEvent("status", { text: "Checking for spoilers..." });
          const cleaned = await censorSpoilers({
            answer,
            highlights,
            game,
            platform,
            userId,
            signal,
          });
          if (cleaned) {
            answer = cleaned.answer;
            highlights = cleaned.highlights;
          }
        }

        sendEvent("result", {
          answer,
          highlights,
          spoilers: spoilerPrefs.major ? spoilers : [],
          sources: sources.map(({ title, url }) => ({ title, url })),
          ...(guideHint ? { guideHint } : {}),
        });
        controller.close();
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
        controller.close();
      }
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
