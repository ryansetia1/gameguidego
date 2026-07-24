import type { MouseEvent, ReactNode } from "react";
import type { Chat } from "@/lib/supabase";
import {
  loadTopicSpoilerPrefs,
  SPOILER_MODE_ON_LABEL,
  TOPIC_SPOILER_CHIP_LABEL,
} from "@/lib/spoiler-prefs.js";
import { displayTopicTitle, resolvedTopicTitle, topicPreviewFromMessages } from "@/lib/topic-title.js";
import { IconDotsVertical, IconPlus } from "../icons";

export type TopicListProps = {
  headerBefore?: ReactNode;
  topics: Chat[];
  menuOpenId: string | null;
  loading: boolean;
  onNewTopic: () => void;
  onOpenTopic: (chat: Chat) => void;
  onToggleRowMenu: (id: string, event: MouseEvent<HTMLButtonElement>) => void;
  onRenameTopic: (chat: Chat) => void;
  onDeleteTopic: (chat: Chat) => void;
};

function topicActivityYear(updatedAt: string) {
  const year = new Date(updatedAt).getFullYear();
  return Number.isFinite(year) ? year : null;
}

/** Show year when the topic is not this year, or the list spans multiple years. */
function shouldShowTopicYear(topics: Chat[], updatedAt: string) {
  const year = topicActivityYear(updatedAt);
  if (year === null) return false;
  const nowYear = new Date().getFullYear();
  if (year !== nowYear) return true;
  const years = new Set(
    topics.map((topic) => topicActivityYear(topic.updated_at)).filter((y) => y !== null),
  );
  return years.size > 1;
}

function formatTopicWhen(updatedAt: string, showYear: boolean) {
  try {
    const date = new Date(updatedAt);
    if (Number.isNaN(date.getTime())) return "";
    const datePart = date.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      ...(showYear ? { year: "numeric" } : {}),
    });
    const timePart = date.toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit",
    });
    if (datePart && timePart) return `${datePart} · ${timePart}`;
    return datePart || timePart;
  } catch {
    return "";
  }
}

export function TopicList({
  headerBefore,
  topics,
  menuOpenId,
  loading,
  onNewTopic,
  onOpenTopic,
  onToggleRowMenu,
  onRenameTopic,
  onDeleteTopic,
}: TopicListProps) {
  return (
    <section className="topic-list" aria-label="Topics">
      {headerBefore}

      {topics.length === 0 ? (
        <div className="topic-list-empty">
          <p>No topics yet. Start one when you have a new question.</p>
          <button type="button" className="quick-new topic-list-new" onClick={onNewTopic} disabled={loading}>
            <IconPlus size={14} aria-hidden />
            New topic
          </button>
        </div>
      ) : (
        <>
          <ul className="topic-list-rows">
            {topics.map((topic) => {
              const preview = topicPreviewFromMessages(topic.messages);
              const showYear = shouldShowTopicYear(topics, topic.updated_at);
              const topicWhen = formatTopicWhen(topic.updated_at, showYear);
              const spoilersOn = loadTopicSpoilerPrefs(topic, topic.game).major;
              return (
                <li key={topic.id} className="topic-row">
                  <button
                    type="button"
                    className="topic-row-open"
                    onClick={() => onOpenTopic(topic)}
                    disabled={loading}
                  >
                    <span className="topic-row-head">
                      <span className="topic-row-title-group">
                        <strong className="topic-row-title">
                          {displayTopicTitle(resolvedTopicTitle(topic))}
                        </strong>
                        {spoilersOn ? (
                          <span
                            className="topic-row-spoiler-chip"
                            aria-label={SPOILER_MODE_ON_LABEL}
                          >
                            {TOPIC_SPOILER_CHIP_LABEL}
                          </span>
                        ) : null}
                      </span>
                    </span>
                    <span className="topic-row-preview-block">
                      {preview ? (
                        <small>{preview}</small>
                      ) : (
                        <small className="topic-row-muted">No messages yet</small>
                      )}
                    </span>
                    {topicWhen ? (
                      <span className="topic-row-meta">{topicWhen}</span>
                    ) : null}
                  </button>
                  <div className="row-menu topic-row-menu">
                    <button
                      type="button"
                      className="kebab topic-row-kebab"
                      aria-label={`Options for ${displayTopicTitle(resolvedTopicTitle(topic))}`}
                      aria-expanded={menuOpenId === topic.id}
                      onClick={(event) => onToggleRowMenu(topic.id, event)}
                      disabled={loading}
                    >
                      <IconDotsVertical />
                    </button>
                    {menuOpenId === topic.id && (
                      <div className="row-menu-pop" role="menu">
                        <button
                          type="button"
                          className="row-menu-item"
                          onClick={() => onRenameTopic(topic)}
                        >
                          Rename
                        </button>
                        <button
                          type="button"
                          className="row-menu-item row-menu-delete"
                          onClick={() => void onDeleteTopic(topic)}
                        >
                          Delete topic
                        </button>
                      </div>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
          <div className="topic-list-footer">
            <button type="button" className="quick-new topic-list-new" onClick={onNewTopic} disabled={loading}>
              <IconPlus size={14} aria-hidden />
              New topic
            </button>
          </div>
        </>
      )}
    </section>
  );
}
