import { NextResponse } from "next/server";

import { getCachedSearch, setCachedSearch } from "@/lib/search-cache";
import { resolveQuestion, summarize, type Turn } from "@/lib/replicate";
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
  const preferredUrl = cleanUrl(record.preferredUrl);
  const history = parseHistory(record.history);
  const images = parseImages(record.images);
  const spoilerPrefs = coerceSpoilerPrefs(record.spoilerPrefs);
  const playerName = coerceDisplayName(record.playerName);

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

  try {
    // Search is best-effort supporting evidence; the model can still answer from
    // its own knowledge if it returns nothing or fails.
    let sources: SearchResult[] = [];
    if (process.env.TAVILY_API_KEY || process.env.SERPER_API_KEY) {
      // Rewrite into a standalone English search query first (first messages
      // benefit from translation/normalisation; follow-ups need context resolved).
      const searchTopic = await resolveQuestion({ question, history });
      const searchQuery = [game, platform, searchTopic, "walkthrough guide"]
        .filter(Boolean)
        .join(" ");
      // Cache the final result per (query + preferred URL) so repeat/popular
      // queries skip the tiered Tavily calls entirely. Best-effort both ways.
      const cacheKey = `${searchQuery}::${preferredUrl}`;
      const cached = await getCachedSearch(cacheKey);
      if (Array.isArray(cached)) {
        sources = cached as SearchResult[];
      } else {
        try {
          sources = await searchGuides(searchQuery, preferredUrl, searchTopic);
          void setCachedSearch(cacheKey, sources);
        } catch (searchError) {
          console.error("Search failed, continuing without sources:", searchError);
        }
      }
    }

    const { answer, highlights, spoilers } = await summarize({
      game,
      platform,
      question,
      sources,
      history,
      images,
      spoilerPrefs,
      playerName,
    });

    return NextResponse.json({
      answer,
      highlights,
      spoilers,
      sources: sources.map(({ title, url }) => ({ title, url })),
    });
  } catch (error) {
    console.error("Guide generation failed:", error);
    const timedOut =
      error instanceof Error &&
      (error.name === "AbortError" || error.name === "TimeoutError");

    return NextResponse.json(
      {
        error: timedOut
          ? "The search took too long. Please try again."
          : "Couldn't build a guide. Please try again shortly.",
      },
      { status: timedOut ? 504 : 502 },
    );
  }
}
