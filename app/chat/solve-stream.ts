import type { Illustration, RetryContext } from "./types";

export type SolveStreamPayload = {
  answer: string;
  sources?: { title: string; url: string }[];
  highlights?: unknown;
  spoilers?: unknown;
  pipelineType?: string;
  guideHint?: string;
  illustration?: Illustration;
  topicTitle?: string;
};

export type JournalUpdatedPayload = {
  summary: string;
  trigger: "auto" | "manual";
  bodyChars: number;
};

export type SolveStreamCallbacks = {
  onStatus?: (text: string) => void;
  onPredictionId?: (id: string) => void;
  onJournalUpdated?: (payload: JournalUpdatedPayload) => void;
};

export type SolveStreamResult = {
  streamStarted: boolean;
  answerData: SolveStreamPayload | null;
  streamError: Error | null;
  retryContext: RetryContext;
};

export async function readSolveStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  callbacks: SolveStreamCallbacks = {},
): Promise<SolveStreamResult> {
  const decoder = new TextDecoder();
  let buffer = "";
  let streamStarted = false;
  let answerData: SolveStreamPayload | null = null;
  let streamError: Error | null = null;
  let retryContext: RetryContext = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    streamStarted = true;
    buffer += decoder.decode(value, { stream: true });

    const parts = buffer.split("\n\n");
    buffer = parts.pop() || "";

    for (const part of parts) {
      if (!part.trim()) continue;
      const eventMatch = part.match(/^event:\s*([^\n]+)/m);
      const dataMatch = part.match(/^data:\s*([^\n]+)/m);
      if (!eventMatch || !dataMatch) continue;

      const eventName = eventMatch[1].trim();
      try {
        const payload = JSON.parse(dataMatch[1].trim());
        if (eventName === "status" && payload.text) {
          callbacks.onStatus?.(payload.text);
        } else if (eventName === "prediction_id" && payload.id) {
          callbacks.onPredictionId?.(payload.id);
        } else if (eventName === "context_ready") {
          retryContext = payload as RetryContext;
        } else if (eventName === "result") {
          answerData = payload as SolveStreamPayload;
        } else if (eventName === "journal_updated") {
          callbacks.onJournalUpdated?.(payload as JournalUpdatedPayload);
        } else if (eventName === "error" && payload.error) {
          streamError = new Error(payload.error);
        }
      } catch {
        // Ignore parsing errors for incomplete chunks.
      }
    }
  }

  return { streamStarted, answerData, streamError, retryContext };
}
