/**
 * @typedef {{ title: string, url: string, score?: number, preview?: string, preferred?: boolean }} SolveLogSource
 */

/**
 * Crawled snippet + metadata for admin `solve_logs.sources`.
 * When multiple RAG chunks share a URL, keep the highest-scored chunk preview.
 *
 * @param {Array<{ title: string, url: string, content?: string, score?: number, preferred?: boolean }>} sources
 * @returns {SolveLogSource[]}
 */
export function sourcesForSolveLog(sources) {
  const bestByUrl = new Map();
  for (const source of sources) {
    const score = source.score ?? 0;
    const prev = bestByUrl.get(source.url);
    if (!prev || score > (prev.score ?? 0)) bestByUrl.set(source.url, source);
  }

  const seen = new Set();
  /** @type {SolveLogSource[]} */
  const out = [];
  for (const source of sources) {
    if (seen.has(source.url)) continue;
    seen.add(source.url);
    const best = bestByUrl.get(source.url) ?? source;
    out.push({
      title: best.title.replace(/\s*\(section \d+\)\s*$/i, ""),
      url: best.url,
      score: best.score,
      preview: (best.content ?? "").slice(0, 800),
      ...(best.preferred ? { preferred: true } : {}),
    });
  }
  return out;
}
