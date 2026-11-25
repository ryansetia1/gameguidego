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
