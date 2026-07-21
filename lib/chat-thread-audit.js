import { coerceMessages } from "./chat-messages.js";
import { pairMessagesIntoTurns, userTurnCount } from "./chat-thread.js";

/**
 * @param {Array<Record<string, unknown>>} messages
 */
function turnSummaries(messages) {
  return pairMessagesIntoTurns(messages).map((turn, index) => {
    const variants = Array.isArray(turn.assistant?.variants)
      ? turn.assistant.variants.length
      : turn.assistant
        ? 1
        : 0;
    const active =
      typeof turn.assistant?.activeVariantIndex === "number"
        ? turn.assistant.activeVariantIndex
        : Math.max(variants - 1, 0);
    return {
      index,
      user: String(turn.user.content).slice(0, 80),
      variants,
      active,
      answered: Boolean(turn.assistant),
    };
  });
}

/**
 * Compare legacy JSONB cache vs normalized rebuild for dual-read validation.
 *
 * @param {unknown} legacyMessages
 * @param {Array<Record<string, unknown>> | null | undefined} normalizedMessages
 */
export function compareThreadSources(legacyMessages, normalizedMessages) {
  const legacy = coerceMessages(legacyMessages);
  const normalized = Array.isArray(normalizedMessages) ? normalizedMessages : [];
  const issues = [];

  const legacyTurns = userTurnCount(legacy);
  const normalizedTurns = userTurnCount(normalized);
  if (legacyTurns !== normalizedTurns) {
    issues.push(`turn_count legacy=${legacyTurns} normalized=${normalizedTurns}`);
  }

  const legacySummary = turnSummaries(legacy);
  const normalizedSummary = turnSummaries(normalized);
  const pairs = Math.min(legacySummary.length, normalizedSummary.length);

  for (let index = 0; index < pairs; index++) {
    const left = legacySummary[index];
    const right = normalizedSummary[index];
    if (left.user !== right.user) {
      issues.push(`turn_${index}_user_mismatch`);
    }
    if (left.variants !== right.variants) {
      issues.push(`turn_${index}_variants legacy=${left.variants} normalized=${right.variants}`);
    }
    if (left.answered !== right.answered) {
      issues.push(`turn_${index}_answered legacy=${left.answered} normalized=${right.answered}`);
    }
  }

  return {
    match: issues.length === 0,
    issues,
    legacyTurns,
    normalizedTurns,
    legacyMessages: legacy.length,
    normalizedMessages: normalized.length,
  };
}
