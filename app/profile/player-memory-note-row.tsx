"use client";

import { useEffect, useState } from "react";

export function EditedBadge() {
  return <span className="player-memory-edited-badge">Edited by you</span>;
}

export function EditableNoteRow({
  value,
  pinned,
  onSave,
  onRemove,
}: {
  value: string;
  pinned: boolean;
  onSave: (next: string) => void;
  onRemove: () => void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => {
    setDraft(value);
  }, [value]);

  return (
    <li className="player-memory-note">
      <textarea
        className="player-memory-note-input player-memory-note-textarea"
        rows={2}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          const trimmed = draft.replace(/\s+/g, " ").trim();
          if (trimmed && trimmed !== value) onSave(trimmed);
          else if (!trimmed) onRemove();
          else setDraft(value);
        }}
      />
      {pinned ? <EditedBadge /> : null}
      <button type="button" className="player-memory-remove" onClick={onRemove} aria-label="Remove note">
        ×
      </button>
    </li>
  );
}
