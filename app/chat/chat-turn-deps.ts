import type { User } from "@supabase/supabase-js";
import type { Dispatch, RefObject, SetStateAction } from "react";
import type { Chat } from "@/lib/supabase";
import type { GuideBundleMeta } from "../guide-link-field";
import type { GuideIndexState } from "@/lib/guide-index-state";
import type { Message } from "./types";
import type { SpoilerPrefs } from "@/lib/spoiler-prefs.js";

export type ChatTurnDeps = {
  temporary: boolean;
  user: User | null;
  game: string;
  platform: string;
  preferredUrls: string[];
  cover: string;
  releaseYear: string;
  messages: Message[];
  input: string;
  editingIndex: number | null;
  loading: boolean;
  guideBundleMeta: Record<string, GuideBundleMeta>;
  bundleIndexStatus: Record<string, { pages: { slug: string }[] }>;
  guideIndexState: GuideIndexState;
  spoilerPrefs: SpoilerPrefs;
  /** Per-topic toggle stored on the chats row (not the global OR effective value). */
  topicSpoilerMajor: boolean;
  setActiveChatId: (id: string | null) => void;
  setChats: import("react").Dispatch<import("react").SetStateAction<Chat[]>>;
  setMessages: Dispatch<SetStateAction<Message[]>>;
  setError: (value: string) => void;
  setRetryAction: (value: (() => void) | null) => void;
  setLoading: (value: boolean) => void;
  setGenerationStatus: (value: string | null) => void;
  setEditingIndex: (value: number | null) => void;
  setIndexingIsBundlePages: (value: boolean) => void;
  setIndexingGuideCount: (value: number) => void;
  setGuideIndexState: Dispatch<SetStateAction<GuideIndexState>>;
  setGuideBundleMeta: Dispatch<SetStateAction<Record<string, GuideBundleMeta>>>;
  setBundleStatusRev: Dispatch<SetStateAction<number>>;
  setConfirmFallbackModal: (value: {
    hint: string;
    hasIndexedGuides: boolean;
    onConfirm: () => void;
    onCancel: () => void;
  } | null) => void;
  setEditingGame: (value: boolean) => void;
  setNewGameOpen: (value: boolean) => void;
  setOptPanel: (value: "guide" | "spoiler" | null) => void;
  setToast: (value: string) => void;
  setInput: (value: string | ((prev: string) => string)) => void;
  setPendingImages: React.Dispatch<
    React.SetStateAction<{ blob?: Blob; preview: string; isExisting?: boolean }[]>
  >;
  activeChatIdRef: RefObject<string | null>;
  variantScrollTargetRef: RefObject<number | null>;
  backgroundMessagesRef: RefObject<Record<string, Message[]>>;
  backgroundLoadingRef: RefObject<Record<string, boolean>>;
  backgroundStatusRef: RefObject<Record<string, string | null>>;
  abortRefs: RefObject<Record<string, AbortController>>;
  predictionIdsRef: RefObject<Record<string, string>>;
  conversationGame: RefObject<string>;
  composerRef: RefObject<HTMLTextAreaElement | null>;
  loadChats: () => Promise<void>;
  resolveCoverUrl: () => Promise<string>;
  uploadMessageImages: () => Promise<string[]>;
  clearPendingImages: () => void;
  deleteMessageImages: (messages: Message[]) => Promise<void>;
  askConfirm: (message: string, confirmLabel?: string, danger?: boolean) => Promise<boolean>;
  /** A guide file/bundle is staged in the picker but not yet added — guard sending without it. */
  guidePending: boolean;
  applyIngestRowToMeta: (
    url: string,
    row: Record<string, unknown>,
    existing?: GuideBundleMeta,
  ) => GuideBundleMeta | undefined;
  startBundleIndexingPoll: (url: string, targets: string[]) => void;
  stopBundleIndexingPoll: () => void;
  normGameKey: (value: string) => string;
};
