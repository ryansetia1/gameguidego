// Guide index status as a plain word after the label (#41): no icon, no box.
// Tone ladder: "" = muted (fine), "attn" = ink bold, "error" = danger bold.
function guideStatus(state: string): { label: string; tone: "" | "attn" | "error"; hint?: string } | null {
  if (state === "indexed") return { label: "Indexed", tone: "" };
  if (state === "limited") {
    return {
      label: "Keyword only",
      tone: "attn",
      hint: "Smart search is temporarily limited for this guide. Refresh to restore full search.",
    };
  }
  if (state === "refreshing") {
    return { label: "Refreshing…", tone: "", hint: "Refreshing guide index in the background." };
  }
  if (state === "paused") {
    return { label: "Paused", tone: "attn", hint: "Guide search is temporarily limited right now." };
  }
  if (state === "failed") return { label: "Failed", tone: "error" };
  if (state === "blocked") return { label: "Blocked", tone: "error" };
  if (state === "pending") return { label: "Pending", tone: "" };
  if (state === "checking") return { label: "Checking…", tone: "" };
  if (state === "unavailable") return { label: "N/A", tone: "attn" };
  return null;
}

export function GuideStatusChip({ state }: { state: string }) {
  const status = guideStatus(state);
  if (!status) return null;
  const toneClass = status.tone ? `meta-text--${status.tone}` : "meta-text";
  return (
    <span className={`guide-status ${toneClass} is-${state}`} title={status.hint}>
      <span aria-hidden="true">· </span>
      {status.label}
      {status.hint ? <span className="visually-hidden">. {status.hint}</span> : null}
    </span>
  );
}
