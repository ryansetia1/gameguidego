import { NextResponse } from "next/server";

import { summarize, type Turn } from "@/lib/replicate";
import { searchWeb } from "@/lib/tavily";

export const runtime = "nodejs";

const MAX_HISTORY = 10;

function cleanText(value: unknown, maxLength: number): string {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim().slice(0, maxLength);
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
      { error: "Permintaan tidak dapat dibaca." },
      { status: 400 },
    );
  }

  const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const question = cleanText(record.question, 300);
  const game = cleanText(record.game, 120);
  const platform = cleanText(record.platform, 40);
  const history = parseHistory(record.history);

  if (question.length < 2) {
    return NextResponse.json(
      { error: "Tuliskan pertanyaanmu dulu ya." },
      { status: 400 },
    );
  }

  if (!process.env.TAVILY_API_KEY || !process.env.REPLICATE_API_TOKEN) {
    return NextResponse.json(
      { error: "Server belum memiliki API key yang diperlukan." },
      { status: 503 },
    );
  }

  try {
    const searchQuery = [game, platform, question, "walkthrough guide strategy"]
      .filter(Boolean)
      .join(" ");
    const sources = await searchWeb(searchQuery);

    if (sources.length === 0) {
      return NextResponse.json(
        { error: "Belum ada panduan tepercaya yang ditemukan." },
        { status: 404 },
      );
    }

    const summary = await summarize({
      game,
      platform,
      question,
      sources,
      history,
    });

    return NextResponse.json({
      summary,
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
          ? "Pencarian memakan waktu terlalu lama. Coba lagi."
          : "Panduan belum dapat dibuat. Coba beberapa saat lagi.",
      },
      { status: timedOut ? 504 : 502 },
    );
  }
}
