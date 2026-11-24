import { IconAlert, IconCheck, IconClock, IconX } from "../icons";

export function GuideStatusChip({ state }: { state: string }) {
  if (state === "indexed") {
    return (
      <span className="guide-status-chip is-indexed">
        <IconCheck size={12} /> Indexed
      </span>
    );
  }
  if (state === "limited") {
    return (
      <span
        className="guide-status-chip is-limited"
        title="Smart search is temporarily limited for this guide. Refresh to restore full search."
      >
        <IconAlert size={12} /> Keyword only
      </span>
    );
  }
  if (state === "refreshing") {
    return (
      <span
        className="guide-status-chip is-refreshing"
        title="Refreshing guide index in the background."
      >
        <IconClock size={12} /> Refreshing…
      </span>
    );
  }
  if (state === "paused") {
    return (
      <span
        className="guide-status-chip is-paused"
        title="Guide search is temporarily limited right now."
      >
        <IconAlert size={12} /> Paused
      </span>
    );
  }
  if (state === "failed") {
    return (
      <span className="guide-status-chip is-failed">
        <IconX size={10} /> Failed
      </span>
    );
  }
  if (state === "blocked") {
    return (
      <span className="guide-status-chip is-blocked">
        <IconAlert size={12} /> Blocked
      </span>
    );
  }
  if (state === "pending") {
    return (
      <span className="guide-status-chip is-pending">
        <IconClock size={12} /> Pending
      </span>
    );
  }
  if (state === "checking") {
    return (
      <span className="guide-status-chip is-checking">
        <IconClock size={12} /> Checking…
      </span>
    );
  }
  if (state === "unavailable") {
    return (
      <span className="guide-status-chip is-unavailable">
        <IconAlert size={12} /> N/A
      </span>
    );
  }
  return null;
}
