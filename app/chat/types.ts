import { coerceMessages } from "@/lib/chat-messages.js";
import type { Highlight, SpoilerReveal } from "@/lib/highlights.js";

export type Source = {
  title: string;
  url: string;
};

export type Illustration = {
  url: string;
  alt: string;
  sourceUrl?: string;
};

/** Client retry payload cached from a dropped solve stream. */
export type RetryContext = {
  searchTopic?: string;
  visualSubject?: string | null;
  sources?: Source[];
  pipelineType?: string;
  guideHint?: string;
  ragGuideUrls?: string[] | null;
} | null;

/** Normalized thread sync scope. */
export type ThreadSyncMode = "tail" | "full";

export type Message = {
  role: "user" | "assistant";
  content: string;
  sources?: Source[];
  highlights?: Highlight[];
  spoilers?: SpoilerReveal[];
  images?: string[];
  illustration?: Illustration;
  pipelineType?: string;
  /** Subset of preferred guides used for this user turn; omitted when Auto. */
  ragGuideUrls?: string[];
  variants?: Omit<Message, "role" | "variants" | "activeVariantIndex">[];
  activeVariantIndex?: number;
};

export function parseStoredMessages(raw: unknown): Message[] {
  return coerceMessages(raw) as Message[];
}
