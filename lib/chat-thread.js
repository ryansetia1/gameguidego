import { coerceMessageVariant, coerceMessages, WRITING_ANSWER_PLACEHOLDER } from "./chat-messages.js";

/**
 * @param {Record<string, unknown>} row
 */
export function responseRowToVariant(row) {
  const sources = Array.isArray(row.sources) ? row.sources : undefined;
  const highlights = Array.isArray(row.highlights) ? row.highlights : undefined;
  const spoilers = Array.isArray(row.spoilers) ? row.spoilers : undefined;
  const pipelineType =
    typeof row.pipeline_type === "string" ? row.pipeline_type : undefined;
  return {
    content: String(row.content),
    ...(sources ? { sources } : {}),
    ...(highlights?.length ? { highlights } : {}),
    ...(spoilers?.length ? { spoilers } : {}),
    ...(pipelineType ? { pipelineType } : {}),
  };
}

/**
 * Rebuild the UI message array from normalized turn/response rows.
 *
 * @param {Array<Record<string, unknown>>} turns
 * @param {Array<Record<string, unknown>>} responses
 * @param {Array<Record<string, unknown>>} states
 * @returns {Array<Record<string, unknown>>}
 */
export function buildMessagesFromNormalized(turns, responses, states) {
  if (!Array.isArray(turns) || !turns.length) return [];

  const sortedTurns = [...turns].sort(
    (a, b) => Number(a.turn_index) - Number(b.turn_index),
  );
  /** @type {Map<string, Array<Record<string, unknown>>>} */
  const responsesByTurn = new Map();
  for (const row of responses || []) {
    const turnId = String(row.turn_id);
    const list = responsesByTurn.get(turnId) || [];
    list.push(row);
    responsesByTurn.set(turnId, list);
  }
  /** @type {Map<string, number>} */
  const stateByTurn = new Map();
  for (const row of states || []) {
    if (typeof row.active_variant_index === "number") {
      stateByTurn.set(String(row.turn_id), row.active_variant_index);
    }
  }

  const messages = [];
  for (const turn of sortedTurns) {
    const turnId = String(turn.id);
    const userImages = Array.isArray(turn.user_images)
      ? turn.user_images.filter((url) => typeof url === "string")
      : [];
    messages.push({
      role: "user",
      content: String(turn.user_content),
      ...(userImages.length ? { images: userImages } : {}),
    });

    const turnResponses = (responsesByTurn.get(turnId) || []).sort(
      (a, b) => Number(a.variant_index) - Number(b.variant_index),
    );
    if (!turnResponses.length) continue;

    const variants = turnResponses.map(responseRowToVariant);
    const activeRaw = stateByTurn.get(turnId);
    const activeIdx =
      typeof activeRaw === "number" &&
      activeRaw >= 0 &&
      activeRaw < variants.length
        ? activeRaw
        : variants.length - 1;
    const active = variants[activeIdx];
    messages.push({
      role: "assistant",
      content: active.content,
      ...(active.sources ? { sources: active.sources } : {}),
      ...(active.highlights?.length ? { highlights: active.highlights } : {}),
      ...(active.spoilers?.length ? { spoilers: active.spoilers } : {}),
      ...(active.pipelineType ? { pipelineType: active.pipelineType } : {}),
      ...(variants.length > 1 ? { variants, activeVariantIndex: activeIdx } : {}),
    });
  }

  return coerceMessages(messages);
}

/**
 * Pair user messages with their following assistant reply (skips in-flight placeholders).
 *
 * @param {Array<Record<string, unknown>>} messages
 */
export function pairMessagesIntoTurns(messages) {
  const turns = [];
  let index = 0;
  while (index < messages.length) {
    const message = messages[index];
    if (message.role !== "user") {
      index++;
      continue;
    }
    const user = message;
    const next = messages[index + 1];
    const assistant =
      next?.role === "assistant" && next.content !== WRITING_ANSWER_PLACEHOLDER
        ? next
        : null;
    turns.push({ user, assistant });
    index += next?.role === "assistant" ? 2 : 1;
  }
  return turns;
}

/**
 * @param {Array<Record<string, unknown>>} messages
 */
export function userTurnCount(messages) {
  return messages.filter((message) => message.role === "user").length;
}

/**
 * Tail sync for follow-ups; full sync when edit/retry drops the thread tail.
 *
 * @param {Array<Record<string, unknown>>} priorMessages
 * @param {Array<Record<string, unknown>>} visibleMessages
 */
export function threadSyncModeForTurn(priorMessages, visibleMessages) {
  return priorMessages.length < visibleMessages.length ? "full" : "tail";
}

/**
 * True when the thread tail is ready for server/client assistant merge.
 *
 * @param {Array<Record<string, unknown>> | null | undefined} messages
 */
export function threadReadyForAssistantMerge(messages) {
  if (!Array.isArray(messages) || !messages.length) return false;
  const last = messages.at(-1);
  if (!last || typeof last !== "object") return false;
  if (last.role === "user") return true;
  return (
    last.role === "assistant" &&
    last.content === WRITING_ANSWER_PLACEHOLDER
  );
}

/**
 * @param {Array<Record<string, unknown>>} priorMessages
 * @param {Record<string, unknown>} userMessage
 */
export function priorMessagesForRegen(priorMessages, userMessage) {
  return priorMessages.at(-1)?.role === "user" ? priorMessages : [...priorMessages, userMessage];
}

/**
 * @param {Array<Record<string, unknown>>} messages
 */
export function lastUserTurnIndex(messages) {
  const userCount = messages.filter((message) => message.role === "user").length;
  return userCount > 0 ? userCount - 1 : -1;
}

/**
 * Derive turn + variant indices after mergeAssistantIntoMessages.
 *
 * @param {Array<Record<string, unknown>>} messages
 */
export function derivePersistContext(messages) {
  const turnIndex = lastUserTurnIndex(messages);
  if (turnIndex < 0) return null;

  const userMessages = messages.filter((message) => message.role === "user");
  const userMsg = userMessages[turnIndex];
  if (!userMsg || typeof userMsg.content !== "string") return null;

  const lastAssistant = messages.at(-1);
  if (!lastAssistant || lastAssistant.role !== "assistant") return null;

  let variantIndex = 0;
  if (Array.isArray(lastAssistant.variants) && lastAssistant.variants.length) {
    variantIndex =
      typeof lastAssistant.activeVariantIndex === "number"
        ? lastAssistant.activeVariantIndex
        : lastAssistant.variants.length - 1;
  }

  return { turnIndex, userMsg, variantIndex, lastAssistant };
}

/**
 * @param {Array<Record<string, unknown>>} messages
 */
export function lastAssistantVariantCount(messages) {
  const last = [...messages].reverse().find((message) => message.role === "assistant");
  if (!last) return 0;
  if (Array.isArray(last.variants) && last.variants.length) return last.variants.length;
  return typeof last.content === "string" && last.content ? 1 : 0;
}

/**
 * Prefer the thread with more turns or more variants on the last assistant.
 *
 * @param {Array<Record<string, unknown>> | null | undefined} normalized
 * @param {Array<Record<string, unknown>> | null | undefined} legacy
 */
export function pickRicherThread(normalized, legacy) {
  const fromNormalized = Array.isArray(normalized) ? normalized : [];
  const fromLegacy = Array.isArray(legacy) ? legacy : [];
  if (!fromNormalized.length) return fromLegacy;
  if (!fromLegacy.length) return fromNormalized;

  const normalizedTurns = userTurnCount(fromNormalized);
  const legacyTurns = userTurnCount(fromLegacy);
  if (normalizedTurns !== legacyTurns) {
    if (
      legacyTurns < normalizedTurns &&
      lastAssistantVariantCount(fromLegacy) > 1
    ) {
      return fromLegacy;
    }
    return normalizedTurns >= legacyTurns ? fromNormalized : fromLegacy;
  }

  if (fromNormalized.length !== fromLegacy.length) {
    return fromNormalized.length >= fromLegacy.length ? fromNormalized : fromLegacy;
  }

  const normalizedVariants = lastAssistantVariantCount(fromNormalized);
  const legacyVariants = lastAssistantVariantCount(fromLegacy);
  if (normalizedVariants !== legacyVariants) {
    return normalizedVariants >= legacyVariants ? fromNormalized : fromLegacy;
  }
  return fromNormalized;
}

/**
 * All assistant variants to upsert after mergeAssistantIntoMessages.
 *
 * @param {Record<string, unknown>} lastAssistant
 * @param {string | undefined} traceId
 */
export function variantRowsFromPersistedAssistant(lastAssistant, traceId) {
  const rawVariants =
    Array.isArray(lastAssistant.variants) && lastAssistant.variants.length
      ? lastAssistant.variants
      : [
          {
            content: lastAssistant.content,
            sources: lastAssistant.sources,
            highlights: lastAssistant.highlights,
            spoilers: lastAssistant.spoilers,
            pipelineType: lastAssistant.pipelineType,
          },
        ];

  const variants = rawVariants
    .map(coerceMessageVariant)
    .filter((variant) => variant !== null);
  if (!variants.length) return [];

  const activeIdx =
    typeof lastAssistant.activeVariantIndex === "number" &&
    lastAssistant.activeVariantIndex >= 0 &&
    lastAssistant.activeVariantIndex < variants.length
      ? lastAssistant.activeVariantIndex
      : variants.length - 1;

  return variants.map((body, index) => ({
    variant_index: index,
    body,
    trace_id: index === activeIdx ? traceId ?? null : null,
  }));
}
