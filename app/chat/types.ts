import { coerceMessages } from "@/lib/chat-messages.js";
import type { Highlight, SpoilerReveal } from "@/lib/highlights.js";

export type Source = {
  title: string;
  url: string;
};

export type Message = {
  role: "user" | "assistant";
  content: string;
  sources?: Source[];
  highlights?: Highlight[];
  spoilers?: SpoilerReveal[];
  images?: string[];
  pipelineType?: string;
  variants?: Omit<Message, "role" | "variants" | "activeVariantIndex">[];
  activeVariantIndex?: number;
};

export function parseStoredMessages(raw: unknown): Message[] {
  return coerceMessages(raw) as Message[];
}
