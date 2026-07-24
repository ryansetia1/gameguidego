import { coerceHighlights, coerceSpoilers } from "./highlights.js";
import {
  pollRecoveredMessages,
  snapshotAssistantVariants,
  WRITING_ANSWER_PLACEHOLDER,
  coerceIllustration,
} from "./chat-messages.js";
import { priorMessagesForRegen } from "./chat-thread.js";

/**
 * Signed-in chats with auth: server `after()` owns the final assistant row.
 * Anon, temporary, or missing chat id stay client-written.
 *
 * @param {{ hasUser: boolean; isTemporary: boolean; hasChatId: boolean; hasAuthToken: boolean }} options
 */
export function serverOwnsAssistantPersist({
  hasUser,
  isTemporary,
  hasChatId,
  hasAuthToken,
}) {
  return Boolean(hasUser && !isTemporary && hasChatId && hasAuthToken);
}

/**
 * @param {{
 *   content: string;
 *   sources: unknown;
 *   highlights?: unknown;
 *   spoilers?: unknown;
 *   pipelineType?: string;
 *   spoilerMajor: boolean;
 *   illustration?: unknown;
 * }} input
 */
export function buildAssistantVariantBody({
  content,
  sources,
  highlights,
  spoilers,
  pipelineType,
  spoilerMajor,
  illustration,
}) {
  const coercedHighlights = coerceHighlights(highlights);
  const coercedSpoilers = coerceSpoilers(spoilers);
  const coercedIllustration = coerceIllustration(illustration);
  return {
    content,
    sources,
    ...(coercedHighlights.length ? { highlights: coercedHighlights } : {}),
    ...(coercedSpoilers.length && spoilerMajor ? { spoilers: coercedSpoilers } : {}),
    ...(pipelineType ? { pipelineType } : {}),
    ...(coercedIllustration ? { illustration: coercedIllustration } : {}),
  };
}

/**
 * Apply a finished assistant answer onto a mutable messages array read from DB.
 *
 * @param {Array<Record<string, unknown>>} messages
 * @param {Record<string, unknown>} variantBody
 * @returns {boolean}
 */
export function mergeAssistantIntoMessages(messages, variantBody) {
  if (!messages.length) return false;
  const lastMessage = messages[messages.length - 1];
  const newAssistantState = { role: "assistant", ...variantBody };

  if (lastMessage.role === "user") {
    messages.push(newAssistantState);
    return true;
  }

  if (
    lastMessage.role === "assistant" &&
    lastMessage.content === WRITING_ANSWER_PLACEHOLDER
  ) {
    const pastVariants = Array.isArray(lastMessage.variants)
      ? lastMessage.variants.filter(
          (variant) =>
            variant &&
            typeof variant === "object" &&
            typeof variant.content === "string" &&
            variant.content !== WRITING_ANSWER_PLACEHOLDER,
        )
      : [];
    messages[messages.length - 1] = {
      ...newAssistantState,
      variants: [...pastVariants, variantBody],
      activeVariantIndex: pastVariants.length,
    };
    return true;
  }

  return false;
}

/**
 * True when the last assistant message differs enough to replace local UI state.
 *
 * @param {Array<Record<string, unknown>>} local
 * @param {Array<Record<string, unknown>>} synced
 */
export function assistantTailDiffers(local, synced) {
  const localLast = local.at(-1);
  const syncedLast = synced.at(-1);
  if (!localLast || !syncedLast) return Boolean(syncedLast);
  if (localLast.content !== syncedLast.content) return true;
  if (localLast.activeVariantIndex !== syncedLast.activeVariantIndex) return true;
  const localVariants = Array.isArray(localLast.variants) ? localLast.variants.length : 0;
  const syncedVariants = Array.isArray(syncedLast.variants) ? syncedLast.variants.length : 0;
  return localVariants !== syncedVariants;
}

/**
 * True when a polled server copy should replace local UI state.
 * Skips incomplete normalized rows (fewer variants than local).
 *
 * @param {Array<Record<string, unknown>>} local
 * @param {Array<Record<string, unknown>>} synced
 */
export function shouldApplySyncedMessages(local, synced) {
  if (!assistantTailDiffers(local, synced)) return false;
  const localLast = local.at(-1);
  const syncedLast = synced.at(-1);
  const localVariants = Array.isArray(localLast?.variants) ? localLast.variants.length : 0;
  const syncedVariants = Array.isArray(syncedLast?.variants) ? syncedLast.variants.length : 0;
  if (syncedVariants < localVariants) return false;
  return true;
}

/**
 * Build the in-memory thread after a successful solve turn (UI shape).
 *
 * @param {{
 *   priorMessages: Array<Record<string, unknown>>;
 *   userMessage: Record<string, unknown>;
 *   oldAssistantMessage?: Record<string, unknown>;
 *   variantBody: Record<string, unknown>;
 * }} input
 */
export function buildTurnMessagesWithAssistant({
  priorMessages,
  userMessage,
  oldAssistantMessage,
  variantBody,
}) {
  if (oldAssistantMessage) {
    const pastVariants = snapshotAssistantVariants(oldAssistantMessage);
    const head = priorMessagesForRegen(priorMessages, userMessage);
    return [
      ...head,
      {
        role: "assistant",
        ...variantBody,
        variants: [...pastVariants, variantBody],
        activeVariantIndex: pastVariants.length,
      },
    ];
  }
  return [
    ...priorMessages,
    userMessage,
    {
      role: "assistant",
      ...variantBody,
    },
  ];
}

/**
 * Wait for the server background save to replace the optimistic placeholder.
 *
 * @param {{
 *   fetchMessages: () => Promise<Array<Record<string, unknown>> | null>;
 *   optimistic: Array<Record<string, unknown>>;
 *   maxAttempts?: number;
 *   intervalMs?: number;
 *   signal?: AbortSignal;
 * }} options
 */
export async function pollUntilMessagesRecovered({
  fetchMessages,
  optimistic,
  maxAttempts = 15,
  intervalMs = 400,
  signal,
}) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (signal?.aborted) return null;
    const loaded = await fetchMessages();
    if (loaded && pollRecoveredMessages(optimistic, loaded)) {
      return loaded;
    }
    if (attempt < maxAttempts - 1) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
  return null;
}
