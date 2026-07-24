// @ts-nocheck
const WEB_RESEARCH_MARKER = "Web research (supporting evidence, may be incomplete or irrelevant):\n";

/** @param {string} prompt @returns {string | null} */
function sliceWebResearchBlock(prompt) {
  const markerIdx = prompt.indexOf(WEB_RESEARCH_MARKER);
  if (markerIdx < 0) return null;
  let body = prompt.slice(markerIdx + WEB_RESEARCH_MARKER.length);
  for (const end of [
    "\n\nThe player attached",
    "\n\nPlayer's new question (reply",
    "\n\nPlayer's new question:",
  ]) {
    const idx = body.indexOf(end);
    if (idx >= 0) body = body.slice(0, idx);
  }
  return body.trim();
}

/** @param {string} prompt @returns {{ web: Array<{ title: string; url: string; preview: string }>; preferred: Array<{ title: string; url: string; preview: string }> }} */
export function extractSnippetsFromSummarizePrompt(prompt) {
  const body = sliceWebResearchBlock(prompt);
  if (!body || body.startsWith("No web results were found.")) {
    return { web: [], preferred: [] };
  }

  const web = [];
  const preferred = [];
  const parts = body.split(/\n(?=\[(?:Source \d+|PREFERRED GUIDE))/);

  for (const part of parts) {
    const sourceMatch = part.match(/^\[Source \d+: ([^\]]+)\]\n([\s\S]*)$/);
    if (sourceMatch) {
      const preview = sourceMatch[2].trim();
      if (preview) {
        web.push({ title: sourceMatch[1].trim(), url: "", preview });
      }
      continue;
    }
    const prefMatch = part.match(/^\[PREFERRED GUIDE[^\]]*\]\n([\s\S]*)$/);
    if (prefMatch) {
      const preview = prefMatch[1].trim();
      if (preview) {
        preferred.push({ title: "Preferred guide", url: "", preview });
      }
    }
  }

  return { web, preferred };
}
