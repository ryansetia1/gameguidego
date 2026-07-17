/**
 * Strip navigation/boilerplate noise from a web search snippet so the prompt
 * receives readable prose instead of markdown link soup, GameFAQs call-to-
 * actions, and Q&A vote/user counters.
 *
 * @param {unknown} text
 * @returns {string}
 */
export function cleanSnippet(text) {
  if (typeof text !== "string") return "";

  return (
    text
      // Markdown links -> keep the visible label only.
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1 ")
      // Bare URLs.
      .replace(/https?:\/\/\S+/g, " ")
      // GameFAQs page call-to-actions.
      .replace(/what do you need help on\??/gi, " ")
      .replace(/would you recommend this (guide|faq)\??/gi, " ")
      // Q&A user + timestamp lines like "lightning012345 - 17 years ago".
      .replace(/\b[\w.-]+ - \d+ years? ago\b/gi, " ")
      .replace(/-\s*report\b/gi, " ")
      // Collapse the many newlines/spaces the extractor leaves behind.
      .replace(/\s+/g, " ")
      .trim()
  );
}
