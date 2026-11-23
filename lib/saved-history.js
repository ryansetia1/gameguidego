/**
 * Back/forward handling for the saved-answers pane (#18), kept pure so it is testable.
 *
 * The pane pushes tagged history entries: `{ gggSaved: "list" }` when it opens, then
 * `{ gggSaved: "read", gggSavedId }` per opened answer. In split mode the chat stays
 * usable, so chat entries (thread, topics, new-game form) and overlays can be pushed
 * ABOVE the pane's entries. Every app entry carries `gggDepth` (see page.tsx
 * pushAppHistory), so a popstate knows its direction and whether it went below the
 * pane's own "list" entry.
 *
 * @typedef {{ gggSaved?: "list" | "read", gggSavedId?: string } | null} SavedEntry
 * @typedef {{ type: "close" }
 *   | { type: "show", readingId: string | null }
 *   | { type: "layer" }
 *   | { type: "none" }} SavedPopAction
 *   close: close the pane. show: pane shows the list (null) or that answer.
 *   layer: an ordinary back (topmost overlay, else the chat's own back).
 *   none: ignore (leftover pane entries, or forward into an entry that can't reopen).
 */

/**
 * @param {{
 *   paneOpen: boolean,
 *   depth: number,       // depth of the entry landed on
 *   prevDepth: number,   // depth of the entry that was left
 *   listDepth: number,   // depth of the pane's "list" entry
 *   left: SavedEntry,    // the entry that was left
 *   landing: SavedEntry, // the entry landed on
 * }} p
 * @returns {SavedPopAction}
 */
export function savedPopAction({ paneOpen, depth, prevDepth, listDepth, left, landing }) {
  const landingTag = landing?.gggSaved;
  const leftTag = left?.gggSaved;
  const showLanding = () => ({
    type: /** @type {const} */ ("show"),
    readingId: landingTag === "read" ? (landing?.gggSavedId ?? null) : null,
  });

  if (!paneOpen) {
    // Stepping onto or off a leftover pane entry (pane closed in place, then
    // back/forward reached it) does nothing; everything else is an ordinary back.
    return landingTag || leftTag ? { type: "none" } : { type: "layer" };
  }
  if (depth > prevDepth) {
    // Forward: reopen what a pane entry names; other entries don't reopen on forward.
    return landingTag ? showLanding() : { type: "none" };
  }
  // Back below the pane's own "list" entry (incl. X's history.go(-1|-2)): close it.
  if (depth < listDepth) return { type: "close" };
  // Back off a "read" entry: the pane steps back to the list (or the answer below).
  if (leftTag === "read") return showLanding();
  // Back off an overlay or a chat entry pushed above the pane.
  return { type: "layer" };
}
