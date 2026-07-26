/** @param {string} value */
export function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Substring match for user/email/id lookup.
 * @param {Array<string | null | undefined>} parts
 * @param {string} query
 */
export function matchesAdminUserSearch(parts, query) {
  const haystack = parts
    .filter((part) => typeof part === "string" && part.trim())
    .join(" ")
    .toLowerCase();
  return haystack.includes(query);
}

/**
 * Whole-token match so short queries like "egi" do not hit "strategi".
 * @param {string} haystack
 * @param {string} query
 */
export function matchesAdminContentSearch(haystack, query) {
  if (!haystack || !query) return false;
  const escaped = escapeRegExp(query);
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i").test(haystack);
}

/**
 * @param {import("./admin-activity").ActivityRow} row
 * @param {string} rawQuery
 */
export function activityRowMatchesSearch(row, rawQuery) {
  const query = rawQuery.trim().toLowerCase();
  if (!query) return true;

  if (matchesAdminUserSearch([row.userLabel, row.userEmail, row.userId], query)) {
    return true;
  }

  const content = [
    row.game,
    row.platform,
    row.service,
    row.provider,
    row.question,
    row.answer,
    row.summary,
    row.traceId,
    ...(row.llmCalls?.flatMap((call) => [call.prompt, call.response, call.system_instruction]) ?? []),
  ]
    .filter(Boolean)
    .join(" ");

  return matchesAdminContentSearch(content, query);
}

/**
 * @param {import("./admin-traces").GroupedTrace} trace
 * @param {string} rawQuery
 */
export function traceMatchesSearch(trace, rawQuery) {
  const query = rawQuery.trim().toLowerCase();
  if (!query) return true;

  if (matchesAdminUserSearch([trace.userName, trace.userId], query)) {
    return true;
  }

  const content = [
    trace.traceId,
    trace.game,
    trace.platform,
    trace.question,
    trace.category,
    trace.pipelineType,
    ...trace.events.map((event) => `${event.event_type} ${event.message}`),
  ]
    .filter(Boolean)
    .join(" ");

  return matchesAdminContentSearch(content, query);
}
