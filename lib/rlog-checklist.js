/**
 * Checklist pane grouping (#71). Steps whose chapter is missing go to a "General"
 * group on top; an untitled chapter is also called "General".
 * @param {{ id: string, title: string }[]} chapters
 * @param {{ id: string, chapter_id: string, title: string, done: boolean }[]} items
 */
export function groupChecklist(chapters, items) {
  const known = new Set(chapters.map((c) => c.id));
  const loose = items.filter((s) => !known.has(s.chapter_id));
  const groups = [
    ...(loose.length ? [{ id: "general", title: "General", items: loose }] : []),
    ...chapters.map((c) => ({
      id: c.id,
      title: c.title.trim() || "General",
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
