/**
 * Checklist pane grouping (#71). Steps whose chapter is missing or untitled share one
 * "General" group on top.
 * @param {{ id: string, title: string }[]} chapters
 * @param {{ id: string, chapter_id: string, title: string, done: boolean }[]} items
 */
export function groupChecklist(chapters, items) {
  const named = chapters.filter((c) => c.title.trim());
  const namedIds = new Set(named.map((c) => c.id));
  const loose = items.filter((s) => !namedIds.has(s.chapter_id));
  const groups = [
    ...(loose.length ? [{ id: "general", title: "General", items: loose }] : []),
    ...named.map((c) => ({
      id: c.id,
      title: c.title.trim(),
      items: items.filter((s) => s.chapter_id === c.id),
    })),
  ];
  return groups.map((g) => ({ ...g, done: g.items.filter((s) => s.done).length, total: g.items.length }));
}

/** Group id holding the first unfinished step (null when everything is done).
 * @param {ReturnType<typeof groupChecklist>} groups */
export function firstOpenGroup(groups) {
  return groups.find((g) => g.items.some((s) => !s.done))?.id ?? null;
}

export const PROGRESS_RECENT_DONE = 5;
const PROGRESS_TITLE_MAX = 120;
const PROGRESS_NOTE_MAX = 160;
export const PROGRESS_MAX_CHARS = 1200;

/** @param {unknown} v @param {number} max */
function oneLine(v, max) {
  if (typeof v !== "string") return "";
  const t = v.replace(/[\u0000-\u001f\u007f\s]+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/**
 * Anti-spoiler block for the summarize prompt (#73), from the room's RLog checklist.
 * Privacy: only step/chapter titles and step notes leave here (no ids, email, cover).
 * "" when there are no steps. Capped: last PROGRESS_RECENT_DONE done steps, per-line
 * caps, and PROGRESS_MAX_CHARS total (older done steps go first).
 * @param {{ chapters?: { id: string, title: string }[], items?: { id: string, chapter_id: string, title: string, done: boolean, note?: string }[] } | null} data
 */
export function buildRlogProgressContext(data) {
  const chapters = Array.isArray(data?.chapters) ? data.chapters.filter((c) => typeof c?.title === "string") : [];
  const items = Array.isArray(data?.items) ? data.items.filter((s) => s && typeof s.title === "string") : [];
  const ordered = groupChecklist(chapters, items).flatMap((g) =>
    g.items.map((s) => ({ s, chapter: g.id === "general" ? "" : g.title })),
  );
  if (!ordered.length) return "";
  /** @param {{ s: { title: string, note?: string }, chapter: string }} e */
  const line = ({ s, chapter }) => {
    const title = oneLine(s.title, PROGRESS_TITLE_MAX) || "Untitled step";
    const ch = oneLine(chapter, PROGRESS_TITLE_MAX);
    const note = oneLine(s.note, PROGRESS_NOTE_MAX);
    return `${ch ? `${ch}: ` : ""}${title}${note ? ` (player note: ${note})` : ""}`;
  };
  const done = ordered.filter((e) => e.s.done).length;
  const head = `PLAYER PROGRESS (from their own RLog checklist for this game, ${done}/${ordered.length} steps done):`;
  const activeIdx = ordered.findIndex((e) => !e.s.done);
  if (activeIdx === -1) {
    return `${head}\nThey have finished every step on their checklist. Spoilers about the story they already played are fine.\n\n`;
  }
  const rules =
    "Rules: do not re-explain steps they already finished unless they ask. Do not reveal anything that comes after their current step (later story, bosses, areas, twists). Answer only what they need to move forward from where they are.";
  const current = `Current step: ${line(ordered[activeIdx])}`;
  let recent = ordered.filter((e) => e.s.done).slice(-PROGRESS_RECENT_DONE).map(line);
  const build = () =>
    [head, recent.length ? `Recently done:\n${recent.map((l) => `- ${l}`).join("\n")}` : "", current, rules]
      .filter(Boolean)
      .join("\n");
  let out = build();
  while (out.length > PROGRESS_MAX_CHARS && recent.length) {
    recent = recent.slice(1);
    out = build();
  }
  return `${out.slice(0, PROGRESS_MAX_CHARS)}\n\n`;
}
