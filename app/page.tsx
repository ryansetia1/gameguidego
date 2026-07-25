"use client";

import type { User } from "@supabase/supabase-js";
import { FormEvent, type MouseEvent, useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { AuthPanel } from "./auth-panel";
import { ActiveGameCard } from "./chat/active-game-card";
import { ComposerShell } from "./chat/composer-shell";
import { CoverThumb, displayPlatform } from "./chat/cover-thumb";
import { GamesSidebar } from "./chat/games-sidebar";
import { HomeSetup } from "./chat/home-setup";
import { HomeTip } from "./chat/hero-marketing";
import { MessageList } from "./chat/message-list";
import { TopicList } from "./chat/topic-list";
import { TopicTitleTypewriter } from "./chat/topic-title-typewriter";
import { PromptDialog, usePromptDialog } from "./chat/use-prompt-dialog";
import { ConfirmDialog, useConfirmDialog } from "./use-confirm-dialog";
import { useChatTurn } from "./chat/use-chat-turn";
import { useGuideBundle } from "./chat/use-guide-bundle";
import { useHomeSession } from "./chat/use-home-session";
import { type Message, parseStoredMessages } from "./chat/types";
import {
  IconChevronDown,
  IconIncognito,
  IconX,
} from "./icons";
import {
  clearNormalizedThread,
  resolveThreadMessages,
} from "@/lib/chat-thread-persist.js";
import {
  guideUrlsFromChat,
  guideUrlsPayload,
  normalizeGuideUrlList,
} from "@/lib/guide-urls.js";
import { compressImage, coverStoragePath } from "@/lib/image.js";
import {
  coverUrlsToStoragePaths,
  removeCoverStoragePaths,
  threadImageStoragePaths,
} from "@/lib/chat-delete.js";
import { type GuideBundleMeta } from "./guide-link-field";
import { HltbRow } from "./hltb-row";
import { type SteamGame } from "./steam-library";
import { ProfileMenu, type NavMenu } from "./profile-menu";
import { Lightbox } from "./lightbox";
import { tgdbPlatformToLabel } from "@/lib/platforms.js";
import {
  effectiveSpoilerPrefs,
  loadGameSpoilerPrefs,
  loadGlobalSpoilerPrefs,
  loadTopicSpoilerPrefs,
  saveGameSpoilerPrefs,
  saveGlobalSpoilerPrefs,
  saveTopicSpoilerMajorById,
  topicSpoilerPayload,
  SPOILER_MODE_OFF_TITLE,
  SPOILER_MODE_ON_LABEL,
  spoilerMajorFromUserMetadata,
} from "@/lib/spoiler-prefs.js";
import { loadVisualAuto } from "@/lib/visual-search-prefs.js";
import { groupChatsByRoom, isTopicColumnDbError, mergeChatsFromServer, normGameKey, syncRoomSharedMeta, syncSharedMetaToLocalGames, topicsForRoom, gameRoomKey, upsertChatInList } from "@/lib/game-room.js";
import {
  displayTopicTitle,
  resolvedTopicTitle,
  saveTopicTitleById,
  shouldShowTopicTitleSkeleton,
  titleFromMessages,
} from "@/lib/topic-title.js";
import { getSupabase, type Chat } from "@/lib/supabase";
import { playerMemoryEnabledFromMetadata } from "@/lib/player-memory.js";
import { forgetGameMemory } from "@/lib/player-memory-game.js";
import {
  loadLocalGames,
  removeLocalGame,
  setLocalGames,
  upsertLocalGame,
} from "@/lib/local-games.js";
import { steamAppIdFromCoverUrl, steamIdFromMetadata } from "@/lib/steam.js";
import { dismissGuideNudge, isGuideNudgeDismissed } from "@/lib/guide-nudge.js";
import {
  loadGuideRetrievalMode,
  saveGuideRetrievalMode,
  toggleGuideRetrievalMode,
} from "@/lib/guide-retrieval-mode.js";
import { getSpeechRecognition } from "@/lib/voice.js";
import {
  clearSessionDraft,
  getChatIdFromUrl,
  loadSessionDraft,
  saveSessionDraft,
  setChatUrl,
} from "@/lib/chat-session.js";
import {
  shouldShowScrollFabForBubble,
  smoothScrollIntoView,
  windowScrollMetrics,
} from "@/lib/chat-scroll.js";


const EXAMPLES_DISMISSED_KEY = "gg:examples-dismissed";
const MAX_MESSAGE_IMAGES = 10;

const examples = [
  { game: "The Legend of Zelda: Link's Awakening", platform: "Game Boy", q: "How do I reach the first dungeon?" },
  { game: "Final Fantasy VII", platform: "PlayStation (PS1)", q: "How do I beat Emerald Weapon?" },
  { game: "Elden Ring", platform: "PC", q: "Best build for beginners" },
];

type GameView = "topics" | "thread" | null;

function collectMessageImagePaths(messages: Message[]): string[] {
  return [
    ...new Set(
      messages
        .flatMap((message) => message.images ?? [])
        .map(coverStoragePath)
        .filter((path): path is string => Boolean(path)),
    ),
  ];
}

async function deleteMessageImages(messages: Message[]) {
  const supabase = getSupabase();
  if (!supabase) return;
  const paths = collectMessageImagePaths(messages);
  if (!paths.length) return;
  try {
    await supabase.storage.from("covers").remove(paths);
  } catch (caught) {
    console.error("Message image cleanup failed:", caught);
  }
}


export default function Home() {
  const [game, setGame] = useState("");
  const [platform, setPlatform] = useState("");
  const [preferredUrls, setPreferredUrls] = useState<string[]>([]);
  const [guideRetrievalMode, setGuideRetrievalMode] = useState<
    "default" | "skip" | "supplement"
  >("default");
  // Which optional section shows below the trigger row — only one at a time, so
  // toggling keeps the two triggers fixed in place instead of reflowing them.
  const [optPanel, setOptPanel] = useState<"guide" | "spoiler" | null>(null);
  const [cover, setCover] = useState("");
  const [pendingCover, setPendingCover] = useState<File | null>(null);
  const [releaseYear, setReleaseYear] = useState("");
  const [editingGame, setEditingGame] = useState(false);
  const [uploadingCover, setUploadingCover] = useState(false);
  const [showSticky, setShowSticky] = useState(false);
  const [pendingImages, setPendingImages] = useState<{ blob?: Blob; preview: string; isExisting?: boolean }[]>([]);
  const [dragActive, setDragActive] = useState(false);
  const [lightboxState, setLightboxState] = useState<{ images: string[]; index: number } | null>(null);
  const [input, setInput] = useState("");
  const [composerExpanded, setComposerExpanded] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [error, setError] = useState("");
  const [retryAction, setRetryAction] = useState<(() => void) | null>(null);
  const [loading, setLoading] = useState(false);
  const [generationStatus, setGenerationStatus] = useState<string | null>(null);
  const [showScrollFab, setShowScrollFab] = useState(false);
  const [indexingGuideCount, setIndexingGuideCount] = useState(0);
  const [confirmFallbackModal, setConfirmFallbackModal] = useState<{
    hint: string;
    hasIndexedGuides: boolean;
    onConfirm: () => void;
    onCancel: () => void;
  } | null>(null);
  const [showQuickAdd, setShowQuickAdd] = useState(false);
  const [guideNudgeDismissed, setGuideNudgeDismissed] = useState(false);

  const [isMounted, setIsMounted] = useState(false);
  useEffect(() => setIsMounted(true), []);

  const [chats, setChats] = useState<Chat[]>(() => {
    if (typeof window !== "undefined") {
      try {
        const cached = window.localStorage.getItem("gg:recent-chats-cache");
        if (cached) return JSON.parse(cached);
      } catch {}
    }
    return [];
  });
  const [chatsLoaded, setChatsLoaded] = useState(false);

  useEffect(() => {
    if (isMounted && chatsLoaded) {
      try {
        if (chats.length > 0) {
          window.localStorage.setItem("gg:recent-chats-cache", JSON.stringify(chats));
        } else {
          window.localStorage.removeItem("gg:recent-chats-cache");
        }
      } catch {}
    }
  }, [chats, isMounted, chatsLoaded]);
  // Home quick-access: hide the setup form behind a "+ New game" reveal when the
  // user already has saved games (signed-in or anon local). Reset on newGame().
  const [newGameOpen, setNewGameOpen] = useState(false);
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const [gameView, setGameView] = useState<GameView>(null);
  // Temporary chat: lives only in memory, never written to Supabase/localStorage/
  // sessionStorage, so a refresh or close wipes it. Follow-ups still work (they
  // read from `messages` state, not storage).
  const [temporary, setTemporary] = useState(false);
  const [authOpen, setAuthOpen] = useState(false);
  const [navMenu, setNavMenu] = useState<NavMenu>(null);
  const navMenuRef = useRef<NavMenu>(null);
  const navMenuHistoryPushed = useRef(false);
  navMenuRef.current = navMenu;
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [steamLibraryOpen, setSteamLibraryOpen] = useState(false);
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null);
  const [examplesDismissed, setExamplesDismissed] = useState(false);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  // While editing, the docked composer is portaled into this in-flow slot so it
  // sits right where the message was (replacing the green bubble).
  const [editSlotEl, setEditSlotEl] = useState<HTMLDivElement | null>(null);
  const [globalSpoilerMajor, setGlobalSpoilerMajor] = useState(false);
  const [gameSpoilerMajor, setGameSpoilerMajor] = useState(false);
  const [visualAuto, setVisualAuto] = useState(true);
  const spoilerPrefs = effectiveSpoilerPrefs(globalSpoilerMajor, gameSpoilerMajor);
  const [voiceListening, setVoiceListening] = useState(false);
  const [voiceSupported, setVoiceSupported] = useState(false);
  const [librarySearch, setLibrarySearch] = useState("");
  const { confirmState, askConfirm, askConfirmWithCheckbox, closeConfirm } = useConfirmDialog();
  const [toast, setToast] = useState("");
  const [lastLibrary, setLastLibrary] = useState<"saved" | "steam">("saved");
  const {
    promptState,
    promptDraft,
    setPromptDraft,
    promptInputRef,
    askPrompt,
    closePrompt,
  } = usePromptDialog();

  const feedRef = useRef<HTMLDivElement>(null);
  const lastUserRef = useRef<HTMLDivElement>(null);
  const lastGuideRef = useRef<HTMLElement>(null);
  const topRef = useRef<HTMLElement>(null);
  const jumpRef = useRef(false);
  const variantScrollTargetRef = useRef<number | null>(null);
  const chatHistoryPushed = useRef(false);
  const topicsHistoryPushed = useRef(false);
  const gameViewRef = useRef<GameView>(null);
  function syncGameView(view: GameView) {
    gameViewRef.current = view;
    setGameView(view);
  }
  const newGameHistoryPushed = useRef(false);
  const homeExitPromptAt = useRef(0);
  const HOME_EXIT_BACK_MS = 2000;
  const sessionHydratedRef = useRef(false);
  const onSignedOutRef = useRef<() => void>(() => {});
  const abortRefs = useRef<Record<string, AbortController>>({});
  const predictionIdsRef = useRef<Record<string, string>>({});
  const backgroundMessagesRef = useRef<Record<string, Message[]>>({});
  const backgroundLoadingRef = useRef<Record<string, boolean>>({});
  const backgroundStatusRef = useRef<Record<string, string | null>>({});
  // Guards session URL/draft sync while openChat is still fetching messages.
  const openingChatIdRef = useRef<string | null>(null);
  const conversationGame = useRef("");
  const conversationPlatform = useRef("");
  const activeChatIdRef = useRef<string | null>(null);
  const chatsRef = useRef<Chat[]>([]);
  // Snapshot of the thread open before entering temporary chat, so turning it off
  // returns there (temporary is a non-destructive detour, not a reset).
  const preTemporaryRef = useRef<{
    activeChatId: string | null;
    messages: Message[];
    game: string;
    platform: string;
    preferredUrls: string[];
    cover: string;
    releaseYear: string;
    conversationGame: string;
    gameView: GameView;
  } | null>(null);
  // Mirror `user` in a ref so the stable loadChats/persist callbacks can branch
  // signed-in (Supabase) vs anon (localStorage) without stale-closure bugs.
  const userRef = useRef<User | null>(null);
  // Guard so the Steam release-year backfill runs at most once per mount.
  const steamBackfillRef = useRef(false);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  // Path of a previously-uploaded cover that a new pick will replace, deleted once
  // the replacement is saved so the bucket doesn't keep the orphan.
  const replacedCoverRef = useRef<string | null>(null);
  function pushOverlayHistory() {
    if (typeof window === "undefined") return;
    window.history.pushState({ gggOverlay: true }, "");
  }

  function pushTopicsHistory() {
    if (typeof window === "undefined") return;
    topicsHistoryPushed.current = true;
    window.history.pushState({ gggTopics: true }, "");
  }

  /** Global loading/status only apply to the open thread; clear when leaving it. */
  function clearActiveTurnUi() {
    setLoading(false);
    setGenerationStatus(null);
  }

  /** Strip overlay marker in-place (no popstate); safe before router.push. */
  function stripOverlayHistory() {
    if (typeof window === "undefined") return;
    const state = window.history.state as { gggOverlay?: boolean } | null;
    if (!state?.gggOverlay) return;
    const next = { ...state };
    delete next.gggOverlay;
    window.history.replaceState(next, "");
  }

  /** Strip overlay marker in-place (no popstate); safe before router.push. */
  function stripNavMenuOverlay() {
    if (typeof window === "undefined") return;
    const state = window.history.state as { gggOverlay?: boolean; gggHomeRoot?: boolean } | null;
    if (!state?.gggOverlay) return;
    const next = { ...state };
    delete next.gggOverlay;
    if (!next.gggHomeRoot) next.gggHomeRoot = true;
    window.history.replaceState(next, "");
  }

  function dismissOverlay() {
    if (typeof window === "undefined") return;
    window.history.back();
  }

  function dismissNavMenu() {
    if (!navMenuRef.current) return;
    // ponytail: popstate closes the menu (like sidebar/library). Clearing state
    // before history.back() lets the handler see navMenu=null and show exit toast.
    if (!navMenuHistoryPushed.current) {
      setNavMenu(null);
      return;
    }
    navMenuHistoryPushed.current = false;
    dismissOverlay();
  }

  /** Close menu before client navigation; strip overlay without history.back(). */
  function closeNavMenuForNav() {
    setNavMenu(null);
    if (!navMenuHistoryPushed.current) return;
    navMenuHistoryPushed.current = false;
    stripNavMenuOverlay();
  }

  function handleNavMenuChange(menu: NavMenu) {
    if (menu === null) {
      dismissNavMenu();
      return;
    }
    const hadMenu = navMenu !== null;
    setNavMenu(menu);
    if (!hadMenu) {
      pushOverlayHistory();
      navMenuHistoryPushed.current = true;
    }
  }

  function closeNewGameForm() {
    if (!newGameHistoryPushed.current) {
      setNewGameOpen(false);
      return;
    }
    dismissOverlay();
  }

  const {
    user,
    authReady,
    steamId,
    supabaseReady,
    steamConnected,
    connectSteam,
    signOut,
  } = useHomeSession({
    authOpen,
    setError,
    setToast,
    setAuthOpen,
    askConfirm,
    onSignedOut: () => onSignedOutRef.current(),
    onSteamLinkNeedsSignIn: pushOverlayHistory,
  });

  const coverEnabled = Boolean(user);

  const {
    guideMeta,
    setGuideMeta,
    guideIndexState,
    setGuideIndexState,
    setStatusRev,
    guideChecking,
    setGuideChecking,
    guidePending,
    setGuidePending,
    retryingUrl,
    isReindexingAll,
    applyIngestRowToMeta,
    retryGuideIngest,
    reindexAllPending,
    resetGuideMeta,
  } = useGuideBundle({
    preferredUrls,
    game,
    platform,
    user,
    setToast,
    setIndexingGuideCount,
  });

  // Grow the composer to fit its text (down to one line when empty), capped by
  // the CSS max-height which then scrolls. Runs on every input + after clearing.
  // Layout expands once scrollHeight passes one line; stays expanded until empty
  // so column vs row width can't re-measure and oscillate (flicker).
  const isExpanded = input.trim().length > 0 && composerExpanded;

  useEffect(() => {
    const el = composerRef.current;
    if (!el) return;
    el.style.height = "auto";
    const height = el.scrollHeight;
    el.style.height = `${height}px`;

    setComposerExpanded((prev) => {
      if (!input.trim()) return false;
      if (height > 50) return true;
      return prev;
    });
    // editSlotEl: the edit portal mounts a fresh textarea after `input` is set,
    // so re-run to size it to the message being edited (otherwise it stays 1 line).
  }, [input, editSlotEl, composerExpanded]);

  useEffect(() => {
    function onPopState() {
      if (confirmFallbackModal) {
        confirmFallbackModal.onCancel();
        return;
      }
      if (steamLibraryOpen) {
        setSteamLibraryOpen(false);
        return;
      }
      if (libraryOpen) {
        setLibraryOpen(false);
        return;
      }
      if (sidebarOpen) {
        setSidebarOpen(false);
        setMenuOpenId(null);
        return;
      }
      if (navMenuRef.current) {
        setNavMenu(null);
        navMenuHistoryPushed.current = false;
        return;
      }
      if (authOpen) {
        setAuthOpen(false);
        return;
      }
      if (newGameOpen) {
        newGameHistoryPushed.current = false;
        setNewGameOpen(false);
        return;
      }
      const view = gameViewRef.current;
      if (view === "thread") {
        chatHistoryPushed.current = false;
        clearActiveTurnUi();
        setMenuOpenId(null);
        setActiveChatId(null);
        setMessages([]);
        setEditingIndex(null);
        setInput("");
        setError("");
        clearPendingImages();
        setTemporary(false);
        syncGameView("topics");
        setChatUrl(null);
        clearSessionDraft();
        const top = window.history.state as { gggTopics?: boolean } | null;
        if (top?.gggTopics) topicsHistoryPushed.current = true;
        else {
          topicsHistoryPushed.current = false;
          pushTopicsHistory();
        }
        return;
      }
      if (view === "topics") {
        goHome();
        return;
      }
      // Home idle: first back warns; second back within 2s leaves the app.
      if (editingGame) return;

      if (
        homeExitPromptAt.current > 0 &&
        Date.now() - homeExitPromptAt.current < HOME_EXIT_BACK_MS
      ) {
        homeExitPromptAt.current = 0;
        return;
      }

      homeExitPromptAt.current = Date.now();
      setToast("Press back again to leave");
      window.history.pushState({ gggHomeRoot: true }, "");
    }
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [
    authOpen,
    libraryOpen,
    sidebarOpen,
    steamLibraryOpen,
    confirmFallbackModal,
    navMenu,
    newGameOpen,
    editingGame,
  ]);

  // Give the browser a history entry to pop when a chat thread is showing (including
  // an empty new-topic composer), so hardware back returns to the topic list without
  // consuming the gggTopics layer underneath.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const inThread = gameView === "thread";
    if (inThread && !chatHistoryPushed.current) {
      chatHistoryPushed.current = true;
      window.history.pushState({ gggChat: true }, "");
    } else if (gameView !== "thread") {
      chatHistoryPushed.current = false;
    }
  }, [gameView]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (gameView === "topics" && !topicsHistoryPushed.current) {
      pushTopicsHistory();
    } else if (gameView !== "topics") {
      topicsHistoryPushed.current = false;
    }
  }, [gameView]);

  // Arm hardware back on home idle so the first press shows a leave hint instead
  // of exiting the PWA immediately. Only seed when the stack top has no guard
  // entry yet (overlay/chat close already leaves gggHomeRoot underneath).
  useEffect(() => {
    if (typeof window === "undefined") return;
    const arm =
      gameView === null &&
      messages.length === 0 &&
      !newGameOpen &&
      !editingGame &&
      !authOpen &&
      !navMenu &&
      !sidebarOpen &&
      !libraryOpen &&
      !steamLibraryOpen;
    if (!arm) {
      if (messages.length > 0 || newGameOpen || gameView !== null) homeExitPromptAt.current = 0;
      return;
    }
    const top = window.history.state as {
      gggHomeRoot?: boolean;
      gggOverlay?: boolean;
      gggChat?: boolean;
      gggTopics?: boolean;
    } | null;
    if (top?.gggHomeRoot || top?.gggOverlay || top?.gggChat || top?.gggTopics) return;
    window.history.pushState({ gggHomeRoot: true }, "");
  }, [
    gameView,
    messages.length,
    newGameOpen,
    editingGame,
    authOpen,
    navMenu,
    sidebarOpen,
    libraryOpen,
    steamLibraryOpen,
  ]);

  useEffect(() => {
    activeChatIdRef.current = activeChatId;
    chatsRef.current = chats;
    gameViewRef.current = gameView;
  }, [activeChatId, chats, gameView]);

  // The in-answer guide nudge is dismissable per game; reload that flag when the
  // open game changes so a "not now" on one game doesn't hide it on another.
  useEffect(() => {
    setGuideNudgeDismissed(isGuideNudgeDismissed(game));
  }, [game]);

  useEffect(() => {
    userRef.current = user;
  }, [user]);

  useEffect(() => {
    if (jumpRef.current) {
      jumpRef.current = false;
      requestAnimationFrame(() => {
        if (lastUserRef.current) {
          lastUserRef.current.scrollIntoView({ behavior: "auto", block: "start" });
        } else {
          feedRef.current?.scrollIntoView({ behavior: "auto", block: "end" });
        }
      });
      return;
    }
    const variantTarget = variantScrollTargetRef.current;
    if (variantTarget != null) {
      variantScrollTargetRef.current = null;
      smoothScrollIntoView(document.getElementById(`msg-guide-${variantTarget}`), {
        behavior: "smooth",
        block: "nearest",
      });
      return;
    }
    smoothScrollIntoView(lastUserRef.current, { behavior: "smooth", block: "start" });
  }, [messages, loading]);

  useEffect(() => {
    setExamplesDismissed(
      typeof window !== "undefined" &&
        window.localStorage.getItem(EXAMPLES_DISMISSED_KEY) === "1",
    );
  }, []);

  const loadChats = useCallback(async (options: { replace?: boolean } = {}) => {
    const supabase = getSupabase();
    if (!supabase || !userRef.current) {
      setChats(loadLocalGames());
      return;
    }
    const fullSelect =
      "id, game, platform, preferred_guide_url, preferred_guide_urls, cover_url, release_year, title, spoiler_major, updated_at, messages";
    const legacySelect =
      "id, game, platform, preferred_guide_url, preferred_guide_urls, cover_url, release_year, updated_at, messages";
    const fullResult = await supabase
      .from("chats")
      .select(fullSelect)
      .order("updated_at", { ascending: false });
    if (!fullResult.error && fullResult.data) {
      const remote = fullResult.data as Chat[];
      setChats((prev) => (options.replace ? remote : mergeChatsFromServer(prev, remote)));
      return;
    }
    const legacyResult = await supabase
      .from("chats")
      .select(legacySelect)
      .order("updated_at", { ascending: false });
    if (!legacyResult.error && legacyResult.data) {
      const remote = legacyResult.data as Chat[];
      setChats((prev) => (options.replace ? remote : mergeChatsFromServer(prev, remote)));
    }
  }, []);

  useEffect(() => {
    if (!authReady) return;
    setChatsLoaded(false);
    void loadChats().finally(() => setChatsLoaded(true));
  }, [user, loadChats, authReady]);

  useEffect(() => {
    if (!authReady || !chatsLoaded || sessionHydratedRef.current) return;

    const chatId = getChatIdFromUrl();
    if (chatId && user) {
      const chat = chats.find((row) => row.id === chatId);
      if (chat) {
        openChat(chat);
        sessionHydratedRef.current = true;
        return;
      }
      setChatUrl(null);
    }

    const draft = loadSessionDraft();
    if (draft) {
      jumpRef.current = true;
      setGame(draft.game);
      setPlatform(draft.platform);
      setPreferredUrls(draft.preferredUrls);
      setCover(draft.cover);
      setPendingCover(null);
      replacedCoverRef.current = null;
      clearPendingImages();
      setReleaseYear(draft.releaseYear);
      setEditingGame(false);
      setInput("");
      setError("");
      setEditingIndex(null);
      conversationGame.current = draft.game;
      conversationPlatform.current = draft.platform;
      if (draft.gameView === "topics") {
        setActiveChatId(null);
        setMessages([]);
        syncGameView("topics");
        setChatUrl(null);
        sessionHydratedRef.current = true;
        return;
      }
      setActiveChatId(draft.activeChatId);
      setMessages(parseStoredMessages(draft.messages));
      syncGameView("thread");
      if (draft.activeChatId && user) setChatUrl(draft.activeChatId);
      sessionHydratedRef.current = true;
      return;
    }

    sessionHydratedRef.current = true;
  }, [authReady, chatsLoaded, user, chats]);

  useEffect(() => {
    if (!chatsLoaded || !user || steamBackfillRef.current) return;
    const supabase = getSupabase();
    if (!supabase) return;
    const pending = chats
      .filter((chat) => !chat.release_year)
      .map((chat) => ({ chat, appId: steamAppIdFromCoverUrl(chat.cover_url ?? "") }))
      .filter((row): row is { chat: Chat; appId: number } => row.appId != null)
      .slice(0, 25);
    if (!pending.length) return;
    steamBackfillRef.current = true;
    void (async () => {
      let filled = 0;
      for (const { chat, appId } of pending) {
        try {
          const res = await fetch(`/api/steam/release-year?appId=${appId}`);
          if (!res.ok) continue;
          const data: { year?: unknown } = await res.json();
          if (typeof data.year !== "string" || !data.year) continue;
          await supabase
            .from("chats")
            .update({ release_year: data.year })
            .eq("id", chat.id);
          filled += 1;
        } catch {
          // best-effort
        }
      }
      if (filled) void loadChats();
    })();
  }, [chatsLoaded, user, chats, loadChats]);

  useEffect(() => {
    if (!sessionHydratedRef.current) return;
    if (messages.length === 0) {
      if (openingChatIdRef.current) return;
      if (gameView === "topics" && game.trim() && !temporary) {
        setChatUrl(null);
        saveSessionDraft({
          game,
          platform,
          preferredUrls,
          cover: cover.startsWith("blob:") ? "" : cover,
          releaseYear,
          activeChatId: null,
          messages: [],
          gameView: "topics",
        });
        return;
      }
      clearSessionDraft();
      setChatUrl(null);
      return;
    }
    if (temporary) {
      clearSessionDraft();
      setChatUrl(null);
      return;
    }
    if (activeChatId && user) {
      setChatUrl(activeChatId);
      clearSessionDraft();
      return;
    }
    setChatUrl(null);
    saveSessionDraft({
      game,
      platform,
      preferredUrls,
      cover: cover.startsWith("blob:") ? "" : cover,
      releaseYear,
      activeChatId,
      messages,
      gameView: "thread",
    });
  }, [
    messages,
    activeChatId,
    game,
    platform,
    preferredUrls,
    cover,
    releaseYear,
    user,
    temporary,
    gameView,
  ]);

  useEffect(() => {
    if (!menuOpenId) return;
    function onPointerDown(event: PointerEvent) {
      if (!(event.target as HTMLElement).closest(".row-menu")) setMenuOpenId(null);
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [menuOpenId]);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(""), 3500);
    return () => clearTimeout(timer);
  }, [toast]);

  // Mobile edge-swipe. Closed: swipe in from the left edge → sidebar; from the
  // right edge → last-opened library (Steam if connected + last used, else saved).
  // Open: swipe back the other way to dismiss (left → close sidebar, right → close
  // library). Signed-in only; ignored while a modal (auth/confirm) or an inline
  // edit is active. ponytail: fixed edge/threshold heuristics; free in the
  // installed PWA (no browser back-gesture to fight there).
  useEffect(() => {
    if (typeof window === "undefined" || !user) return;
    const EDGE = 24;
    const THRESHOLD = 60;
    const modalOpen =
      authOpen ||
      navMenu !== null ||
      confirmState !== null ||
      promptState !== null ||
      editingGame ||
      editingIndex !== null;
    const overlayOpen = sidebarOpen || libraryOpen || steamLibraryOpen;
    let startX = 0;
    let startY = 0;
    let tracking = false;

    function onStart(event: TouchEvent) {
      if (modalOpen || event.touches.length !== 1) {
        tracking = false;
        return;
      }
      const t = event.touches[0];
      startX = t.clientX;
      startY = t.clientY;
      // Overlay open → any horizontal swipe on the panel can dismiss it; closed →
      // only start tracking from a screen edge.
      tracking =
        overlayOpen || t.clientX <= EDGE || t.clientX >= window.innerWidth - EDGE;
    }

    function onEnd(event: TouchEvent) {
      if (!tracking) return;
      tracking = false;
      const t = event.changedTouches[0];
      const dx = t.clientX - startX;
      const dy = t.clientY - startY;
      if (Math.abs(dx) < THRESHOLD || Math.abs(dx) < Math.abs(dy) * 1.5) return;
      // Dismiss an open panel with the reverse swipe.
      if (sidebarOpen) {
        if (dx < 0) dismissOverlay();
        return;
      }
      if (libraryOpen || steamLibraryOpen) {
        if (dx > 0) dismissOverlay();
        return;
      }
      // Nothing open → edge-swipe opens.
      if (startX <= EDGE && dx > 0) {
        setSidebarOpen(true);
        pushOverlayHistory();
      } else if (startX >= window.innerWidth - EDGE && dx < 0) {
        if (steamConnected && lastLibrary === "steam") openSteamLibrary();
        else openSavedLibrary();
      }
    }

    window.addEventListener("touchstart", onStart, { passive: true });
    window.addEventListener("touchend", onEnd, { passive: true });
    return () => {
      window.removeEventListener("touchstart", onStart);
      window.removeEventListener("touchend", onEnd);
    };
  }, [
    user,
    sidebarOpen,
    libraryOpen,
    steamLibraryOpen,
    authOpen,
    confirmState,
    promptState,
    editingGame,
    editingIndex,
    steamConnected,
    lastLibrary,
  ]);

  useEffect(() => {
    setGlobalSpoilerMajor(loadGlobalSpoilerPrefs().major);
    setVisualAuto(loadVisualAuto());
  }, []);

  useEffect(() => {
    setVoiceSupported(Boolean(getSpeechRecognition()));
  }, []);

  useEffect(() => {
    if (!user) return;
    const remote = spoilerMajorFromUserMetadata(user.user_metadata);
    if (remote !== null) {
      setGlobalSpoilerMajor(remote);
      saveGlobalSpoilerPrefs({ major: remote });
    }
  }, [user]);

  // Load per-topic spoiler when switching game/topic — not on every chats refresh
  // (loadChats after toggle would reset the checkbox via stale server rows).
  useEffect(() => {
    if (!game.trim()) {
      setGameSpoilerMajor(false);
      return;
    }
    if (!activeChatId) {
      setGameSpoilerMajor(loadGameSpoilerPrefs(game).major);
      return;
    }
    const row = chatsRef.current.find((chat) => chat.id === activeChatId);
    setGameSpoilerMajor(loadTopicSpoilerPrefs(row, game).major);
  }, [game, activeChatId]);

  useEffect(() => {
    if (messages.length > 0 && gameView === null && game.trim()) {
      syncGameView("thread");
    }
  }, [messages.length, gameView, game]);

  const updateGlobalSpoiler = useCallback((value: boolean) => {
    setGlobalSpoilerMajor(value);
    saveGlobalSpoilerPrefs({ major: value });
  }, []);

  const updateGameSpoiler = useCallback(
    async (value: boolean) => {
      setGameSpoilerMajor(value);
      const chatId = activeChatIdRef.current;
      if (chatId) {
        setChats((prev) =>
          prev.map((row) =>
            row.id === chatId ? { ...row, ...topicSpoilerPayload(value) } : row,
          ),
        );
      }
      const supabase = getSupabase();
      if (chatId && supabase && user) {
        let { error } = await supabase
          .from("chats")
          .update(topicSpoilerPayload(value))
          .eq("id", chatId);
        if (error && isTopicColumnDbError(error)) {
          saveTopicSpoilerMajorById(chatId, value);
          error = null;
        }
        if (!error) void loadChats();
      } else if (chatId && !user) {
        const row = loadLocalGames().find((entry) => entry.id === chatId);
        if (row) {
          upsertLocalGame({ ...row, ...topicSpoilerPayload(value) });
          setChats(loadLocalGames());
        }
      } else if (chatId) {
        saveTopicSpoilerMajorById(chatId, value);
      } else if (game.trim()) {
        saveGameSpoilerPrefs(game, { major: value });
      }
    },
    [game, user, loadChats],
  );

  const turnOffSpoilers = useCallback(() => {
    if (gameSpoilerMajor) {
      updateGameSpoiler(false);
    } else if (globalSpoilerMajor) {
      updateGlobalSpoiler(false);
    }
  }, [gameSpoilerMajor, globalSpoilerMajor, updateGameSpoiler, updateGlobalSpoiler]);

  const toggleEffectiveSpoiler = useCallback(() => {
    if (spoilerPrefs.major) {
      turnOffSpoilers();
    } else {
      updateGameSpoiler(true);
    }
  }, [spoilerPrefs.major, turnOffSpoilers, updateGameSpoiler]);

  useEffect(() => {
    setGuideRetrievalMode(loadGuideRetrievalMode());
  }, []);

  useEffect(() => {
    saveGuideRetrievalMode(guideRetrievalMode);
  }, [guideRetrievalMode]);

  useEffect(() => {
    if (preferredUrls.length === 0 && guideRetrievalMode !== "default") {
      setGuideRetrievalMode("default");
    }
  }, [preferredUrls.length, guideRetrievalMode]);

  const toggleSkipGuide = useCallback(() => {
    setGuideRetrievalMode((prev) => toggleGuideRetrievalMode(prev, "skip"));
  }, []);

  const toggleSupplementGuide = useCallback(() => {
    setGuideRetrievalMode((prev) => toggleGuideRetrievalMode(prev, "supplement"));
  }, []);

  useEffect(() => {
    if (editingIndex === null) return;
  }, [editingIndex]);

  // Show the compact sticky header once the game card scrolls out of view.
  // Empty thread (new topic): full game card stays visible, no mini header.
  useEffect(() => {
    const element = topRef.current;
    const stickyEligible =
      gameView === "topics" || (gameView === "thread" && messages.length > 0);
    if (!element || !stickyEligible) {
      setShowSticky(false);
      return;
    }
    const observer = new IntersectionObserver(
      ([entry]) => setShowSticky(!entry.isIntersecting),
      { threshold: 0 },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [messages.length, editingGame, gameView]);

  // Jump-to-bottom FAB: show when the thread overflows and the user scrolls up.
  useEffect(() => {
    if (typeof window === "undefined" || messages.length === 0) {
      setShowScrollFab(false);
      return;
    }
    const update = () => {
      const top = lastGuideRef.current?.getBoundingClientRect().top ?? null;
      setShowScrollFab(shouldShowScrollFabForBubble(windowScrollMetrics(), top));
    };
    update();
    let raf = 0;
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        update();
      });
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [messages.length, loading]);

  function dismissExamples() {
    window.localStorage.setItem(EXAMPLES_DISMISSED_KEY, "1");
    setExamplesDismissed(true);
  }

  function newGame() {
    clearActiveTurnUi();
    setChatUrl(null);
    clearSessionDraft();
    setActiveChatId(null);
    syncGameView(null);
    setMessages([]);
    setGame("");
    setPlatform("");
    setPreferredUrls([]);
    resetGuideMeta();
    if (cover.startsWith("blob:")) URL.revokeObjectURL(cover);
    setCover("");
    setPendingCover(null);
    replacedCoverRef.current = null;
    clearPendingImages();
    setReleaseYear("");
    setEditingGame(false);
    setInput("");
    setError("");
    setEditingIndex(null);
    conversationGame.current = "";
    conversationPlatform.current = "";
    setSidebarOpen(false);
    setMenuOpenId(null);
    setTemporary(false);
    newGameHistoryPushed.current = false;
    topicsHistoryPushed.current = false;
    // Back to quick-access home; the setup form re-hides behind "+ New game".
    setNewGameOpen(false);
  }

  // Temporary chat is a non-destructive detour. Turning it ON snapshots the open
  // thread (which is already saved) and starts a fresh in-memory thread, keeping
  // the game/platform/cover so you can ask the same game off the record. Turning
  // it OFF restores that snapshot, so cancelling before chatting drops you back
  // where you were. Only discarding a temporary thread that has content confirms.
  async function toggleTemporary() {
    if (loading) return;

    // Shared reset of transient composer/edit state.
    const clearTransient = () => {
      clearPendingImages();
      setInput("");
      setError("");
      setEditingIndex(null);
    };

    if (!temporary) {
      preTemporaryRef.current = {
        activeChatId,
        messages,
        game,
        platform,
        preferredUrls,
        cover,
        releaseYear,
        conversationGame: conversationGame.current,
        gameView,
      };
      clearTransient();
      setMessages([]);
      setActiveChatId(null);
      conversationGame.current = "";
      conversationPlatform.current = "";
      clearSessionDraft();
      setChatUrl(null);
      setTemporary(true);
      if (gameView === "topics") {
        syncGameView("thread");
        setShowSticky(false);
        requestAnimationFrame(() => {
          window.scrollTo({ top: 0, behavior: "auto" });
          composerRef.current?.focus();
        });
      }
      return;
    }

    if (
      messages.length > 0 &&
      !(await askConfirm(
        "Turn off temporary chat? This conversation won't be saved.",
        "Discard",
      ))
    ) {
      return;
    }

    const prior = preTemporaryRef.current;
    preTemporaryRef.current = null;
    clearTransient();
    setTemporary(false);
    if (prior) {
      // Jump to the last user message like openChat, so the restored thread lands
      // where it was rather than scrolled to the top.
      if (prior.messages.length) jumpRef.current = true;
      setActiveChatId(prior.activeChatId);
      setMessages(prior.messages);
      setGame(prior.game);
      setPlatform(prior.platform);
      setPreferredUrls(prior.preferredUrls);
      setCover(prior.cover);
      setReleaseYear(prior.releaseYear);
      conversationGame.current = prior.conversationGame;
      syncGameView(prior.gameView);
      // Restore the saved-chat deep link so a later refresh reopens it.
      if (prior.activeChatId && user) setChatUrl(prior.activeChatId);
    } else {
      setMessages([]);
      setActiveChatId(null);
      conversationGame.current = "";
    conversationPlatform.current = "";
    }
  }

  // Explicit "+ New game": reset, then reveal the setup form (with animation)
  // and focus the game field. newGame() alone returns to the quick-access view.
  function startNewGame() {
    newGame();
    setNewGameOpen(true);
    newGameHistoryPushed.current = true;
    pushOverlayHistory();
    requestAnimationFrame(() => {
      document.getElementById("game")?.focus();
    });
  }

  function applyRoomContext(chat: Chat) {
    setGame(chat.game);
    setPlatform(chat.platform);
    setPreferredUrls(guideUrlsFromChat(chat));
    if (cover.startsWith("blob:")) URL.revokeObjectURL(cover);
    setCover(chat.cover_url ?? "");
    setPendingCover(null);
    replacedCoverRef.current = null;
    clearPendingImages();
    setReleaseYear(chat.release_year ?? "");
    conversationGame.current = chat.game;
    conversationPlatform.current = chat.platform;
    setGameSpoilerMajor(loadTopicSpoilerPrefs(chat, chat.game).major);
  }

  function openGameRoom(chat: Chat) {
    clearActiveTurnUi();
    jumpRef.current = true;
    applyRoomContext(chat);
    setActiveChatId(null);
    setMessages([]);
    setEditingGame(false);
    setInput("");
    setError("");
    setEditingIndex(null);
    setSidebarOpen(false);
    setMenuOpenId(null);
    setTemporary(false);
    syncGameView("topics");
    setChatUrl(null);
    setLibraryOpen(false);
    setSteamLibraryOpen(false);
    pushTopicsHistory();
    void loadChats();
  }

  function backToTopicList() {
    clearActiveTurnUi();
    setMenuOpenId(null);
    if (typeof window !== "undefined" && chatHistoryPushed.current) {
      window.history.back();
      return;
    }
    activeChatIdRef.current = null;
    setActiveChatId(null);
    setMessages([]);
    setEditingIndex(null);
    setInput("");
    setError("");
    clearPendingImages();
    setTemporary(false);
    syncGameView("topics");
    setChatUrl(null);
    void loadChats();
  }

  function startNewTopic() {
    setMenuOpenId(null);
    // Reuse an empty "save for later" topic if this room has one, so the first
    // question fills that row instead of orphaning it.
    const emptyTopic = topicsForRoom(chats, game, platform).find(
      (t) => !Array.isArray(t.messages) || t.messages.length === 0,
    );
    activeChatIdRef.current = emptyTopic?.id ?? null;
    setActiveChatId(emptyTopic?.id ?? null);
    setMessages([]);
    setEditingIndex(null);
    setInput("");
    setError("");
    clearPendingImages();
    setTemporary(false);
    setGameSpoilerMajor(false);
    syncGameView("thread");
    setChatUrl(null);
    clearSessionDraft();
    setShowSticky(false);
    requestAnimationFrame(() => {
      window.scrollTo({ top: 0, behavior: "auto" });
      composerRef.current?.focus();
    });
  }

  function commitOpenChat(chat: Chat, loaded: Message[], isBgLoading: boolean) {
    jumpRef.current = true;
    setChatUrl(chat.id);
    clearSessionDraft();
    activeChatIdRef.current = chat.id;
    setActiveChatId(chat.id);
    applyRoomContext(chat);
    setEditingGame(false);
    setMessages(loaded);
    setLoading(isBgLoading || false);
    setGenerationStatus(backgroundStatusRef.current[chat.id] || null);
    setInput("");
    setError("");
    setEditingIndex(null);
    setSidebarOpen(false);
    setMenuOpenId(null);
    setTemporary(false);
    syncGameView("thread");
  }

  async function openChat(chat: Chat) {
    openingChatIdRef.current = chat.id;
    try {
      const isBgLoading = backgroundLoadingRef.current[chat.id] ?? false;
      const preview =
        backgroundMessagesRef.current[chat.id] ?? parseStoredMessages(chat.messages);
      const supabase = getSupabase();

      if (preview.length) commitOpenChat(chat, preview, isBgLoading);

      if (supabase && user) {
        const fresh = (await resolveThreadMessages(supabase, chat)) as Message[];
        if (openingChatIdRef.current !== chat.id) return;
        if (preview.length) setMessages(fresh);
        else commitOpenChat(chat, fresh, isBgLoading);
      } else if (!preview.length) {
        commitOpenChat(chat, parseStoredMessages(chat.messages), isBgLoading);
      }
    } finally {
      if (openingChatIdRef.current === chat.id) openingChatIdRef.current = null;
    }
  }

  // Autocomplete pick carries box art + year + platform; manual typing clears the
  // stale cover. Platform is mapped to our label when confident (else left as-is).
  function pickGame(picked: {
    name: string;
    year: string;
    cover: string;
    platform: string;
  }) {
    setGame(picked.name);
    setReleaseYear(picked.year);
    setPendingCover(null);
    setCover(coverEnabled ? picked.cover : "");
    const label = tgdbPlatformToLabel(picked.platform);
    if (label) setPlatform(label);
  }

  function handleGameChange(value: string) {
    setGame(value);
    if (cover) setCover("");
    if (pendingCover) setPendingCover(null);
    if (releaseYear) setReleaseYear("");
  }

  // Hold the chosen file locally and preview it; the actual Storage upload is
  // deferred to save time (first message / Done) so abandoned picks cost nothing.
  function selectCover(file: File) {
    if (!file.type.startsWith("image/")) {
      setError("Please choose an image file.");
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      setError("Cover must be under 5 MB.");
      return;
    }
    // Remember the uploaded cover being replaced (keep the earliest across repeated
    // picks; blob previews have no storage path).
    const oldPath = coverStoragePath(cover);
    if (oldPath) replacedCoverRef.current = oldPath;
    if (cover.startsWith("blob:")) URL.revokeObjectURL(cover);
    setPendingCover(file);
    setCover(URL.createObjectURL(file));
  }

  // Resolve the cover_url to persist: upload a pending file now, keep an existing
  // real URL, or "" — never persists a local blob: preview. Best-effort.
  async function resolveCoverUrl(): Promise<string> {
    if (!pendingCover) return cover.startsWith("blob:") ? "" : cover;
    const supabase = getSupabase();
    if (!supabase || !user) return "";
    setUploadingCover(true);
    try {
      const ext =
        (pendingCover.name.split(".").pop() || "jpg")
          .toLowerCase()
          .replace(/[^a-z0-9]/g, "") || "jpg";
      const path = `${user.id}/${crypto.randomUUID()}.${ext}`;
      const { error: upErr } = await supabase.storage
        .from("covers")
        .upload(path, pendingCover, { upsert: true, contentType: pendingCover.type });
      if (upErr) throw upErr;
      const url = supabase.storage.from("covers").getPublicUrl(path).data.publicUrl;
      if (cover.startsWith("blob:")) URL.revokeObjectURL(cover);
      setPendingCover(null);
      setCover(url);
      // Delete the cover this one replaced, now that the new one is saved.
      const replaced = replacedCoverRef.current;
      replacedCoverRef.current = null;
      if (replaced && replaced !== path) {
        supabase.storage
          .from("covers")
          .remove([replaced])
          .catch((caught) => console.error("Cover cleanup failed:", caught));
      }
      return url;
    } catch (caught) {
      console.error("Cover upload failed:", caught);
      setError("Cover upload failed. Make sure the 'covers' storage bucket exists.");
      return "";
    } finally {
      setUploadingCover(false);
    }
  }

  async function clearCover() {
    if (!(await askConfirm("Remove this cover image?"))) return;
    const toRemove = [coverStoragePath(cover), replacedCoverRef.current].filter(
      (path): path is string => Boolean(path),
    );
    replacedCoverRef.current = null;
    if (cover.startsWith("blob:")) URL.revokeObjectURL(cover);
    setCover("");
    setPendingCover(null);
    const supabase = getSupabase();
    const roomGame = conversationGame.current || game;
    const roomPlatform = conversationPlatform.current || platform;
    if (!supabase || !user) {
      if (roomGame.trim()) {
        const synced = syncSharedMetaToLocalGames(loadLocalGames(), roomGame, roomPlatform, {
          cover_url: "",
        });
        setChats(setLocalGames(synced));
      }
    } else if (roomGame.trim()) {
      try {
        await syncRoomSharedMeta(supabase, user.id, roomGame, roomPlatform, {
          cover_url: "",
        });
        void loadChats();
      } catch (caught) {
        console.error("Failed to clear cover:", caught);
      }
    }
    if (supabase && toRemove.length) {
      await removeCoverStoragePaths(supabase, toRemove);
    }
  }

  async function saveGameMeta() {
    setEditingGame(false);
    const priorGame = conversationGame.current || game;
    const priorPlatform = conversationPlatform.current || platform;
    const urls = normalizeGuideUrlList(preferredUrls);
    setPreferredUrls(urls);
    const supabase = getSupabase();
    const sharedMeta = {
      game,
      platform,
      ...guideUrlsPayload(urls),
      release_year: releaseYear,
    };
    // Anon: sync metadata across every topic in this room.
    if (!supabase || !user) {
      const coverUrl = cover.startsWith("blob:") ? "" : cover;
      const priorKey = gameRoomKey(priorGame, priorPlatform);
      const synced = syncSharedMetaToLocalGames(loadLocalGames(), priorGame, priorPlatform, {
        ...guideUrlsPayload(urls),
        cover_url: coverUrl,
        release_year: releaseYear,
      }).map((row) =>
        gameRoomKey(row.game, row.platform) === priorKey ? { ...row, ...sharedMeta, cover_url: coverUrl } : row,
      );
      setChats(setLocalGames(synced));
      conversationGame.current = game;
      conversationPlatform.current = platform;
      return;
    }
    try {
      const coverUrl = await resolveCoverUrl();
      await syncRoomSharedMeta(supabase, user.id, priorGame, priorPlatform, {
        ...sharedMeta,
        cover_url: coverUrl,
      });
      conversationGame.current = game;
      conversationPlatform.current = platform;
      void loadChats();
    } catch (caught) {
      console.error("Failed to save game details:", caught);
    }
  }

  // Save a set-up game (name/platform/guides/cover) to the library without asking
  // yet. persistChat with empty messages creates the room; guides already indexed
  // on add, so this only persists the room association. Returns home to prep more.
  async function saveNewGame() {
    if (!game.trim() || loading) return;
    const id = await persistChat([], null);
    if (!id) {
      setToast("Couldn't save that game. Try again.");
      return;
    }
    setToast("Saved. Find it in your games.");
    newGame();
  }

  function editGame(chat: Chat, event: MouseEvent<HTMLButtonElement>) {
    event.stopPropagation();
    openGameRoom(chat);
    setEditingGame(true);
  }

  function scrollToTop() {
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function scrollToLatest() {
    const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
    window.scrollTo({
      top: document.documentElement.scrollHeight + 9999,
      behavior: reduceMotion ? "auto" : "smooth",
    });
    setShowScrollFab(false);
  }

  // Return to the empty home view. Logo and explicit "Home" always reset here;
  // hardware back from a thread still pops to the topic list via popstate.
  function goHome() {
    chatHistoryPushed.current = false;
    topicsHistoryPushed.current = false;
    newGame();
  }

  // Themed confirm dialog via useConfirmDialog (shared with profile memory).
  // when the user acts. Shared by every destructive action. `confirmLabel`
  // overrides the default "Delete" button text (e.g. "Discard").
  function openSavedLibrary() {
    setSidebarOpen(false);
    setMenuOpenId(null);
    setLibrarySearch("");
    setLastLibrary("saved");
    setLibraryOpen(true);
    pushOverlayHistory();
  }

  function openSteamLibrary() {
    setSidebarOpen(false);
    setMenuOpenId(null);
    setLastLibrary("steam");
    setSteamLibraryOpen(true);
    pushOverlayHistory();
  }

  function openFromLibrary(chat: Chat) {
    setLibraryOpen(false);
    setSidebarOpen(false);
    setMenuOpenId(null);
    stripOverlayHistory();
    openGameRoom(chat);
  }

  function editFromLibrary(chat: Chat) {
    setMenuOpenId(null);
    openFromLibrary(chat);
    setEditingGame(true);
  }


  function startFromSteamGame(game: SteamGame) {
    setSteamLibraryOpen(false);
    setSidebarOpen(false);
    setLibraryOpen(false);
    setMenuOpenId(null);
    stripOverlayHistory();

    const existing = chats.find(
      (chat) =>
        chat.game.toLowerCase() === game.name.toLowerCase() &&
        (chat.platform === "PC" || !chat.platform),
    );
    if (existing) {
      openGameRoom(existing);
      return;
    }

    clearActiveTurnUi();
    jumpRef.current = true;
    setActiveChatId(null);
    setMessages([]);
    setGame(game.name);
    setPlatform("PC");
    setPreferredUrls([]);
    resetGuideMeta();
    if (cover.startsWith("blob:")) URL.revokeObjectURL(cover);
    setCover(coverEnabled ? game.cover : "");
    setPendingCover(null);
    replacedCoverRef.current = null;
    clearPendingImages();
    // Year already came with the library shelf (batch GetItems) — set it now so
    // the card shows "PC · year" immediately and it persists on first save.
    setReleaseYear(game.releaseYear ?? "");
    setEditingGame(false);
    setInput("");
    setError("");
    setEditingIndex(null);
    conversationGame.current = game.name;
    conversationPlatform.current = "PC";
    setNewGameOpen(true);
    newGameHistoryPushed.current = true;
    pushOverlayHistory();
    requestAnimationFrame(() => {
      document.getElementById("game")?.focus();
    });

    // Fallback only when the shelf had no year (game missing from GetItems).
    if (game.releaseYear) return;
    void (async () => {
      try {
        const response = await fetch(`/api/steam/release-year?appId=${game.appId}`);
        if (!response.ok) return;
        const data: { year?: unknown } = await response.json();
        if (typeof data.year !== "string" || !data.year) return;
        if (conversationGame.current !== game.name) return;
        setReleaseYear(data.year);
        const supabase = getSupabase();
        if (supabase && user && conversationGame.current === game.name) {
          await syncRoomSharedMeta(supabase, user.id, game.name, "PC", {
            release_year: data.year,
            updated_at: new Date().toISOString(),
          });
          void loadChats();
        }
      } catch {
        // best-effort — chat works without a year
      }
    })();
  }

  // Message image attachments: compress + preview locally now, upload to Storage
  // at send time. Signed-in only (Storage RLS); anon users keep full text access.
  async function selectMessageImages(files: FileList | null) {
    if (!files || !user) return;
    const room = MAX_MESSAGE_IMAGES - pendingImages.length;
    const chosen = Array.from(files)
      .filter((file) => file.type.startsWith("image/"))
      .slice(0, Math.max(0, room));
    if (!chosen.length) return;
    const added = await Promise.all(
      chosen.map(async (file) => {
        const blob = await compressImage(file);
        return { blob, preview: URL.createObjectURL(blob) };
      }),
    );
    setPendingImages((prev) => [...prev, ...added].slice(0, MAX_MESSAGE_IMAGES));
  }

  function removePendingImage(index: number) {
    setPendingImages((prev) => {
      const target = prev[index];
      if (target && !target.isExisting) URL.revokeObjectURL(target.preview);
      return prev.filter((_, i) => i !== index);
    });
  }

  function clearPendingImages() {
    setPendingImages((prev) => {
      for (const item of prev) {
        if (!item.isExisting) URL.revokeObjectURL(item.preview);
      }
      return [];
    });
  }

  async function uploadMessageImages(): Promise<string[]> {
    if (!pendingImages.length) return [];
    const supabase = getSupabase();
    
    const urls: string[] = [];
    for (const item of pendingImages) {
      if (item.isExisting) {
        urls.push(item.preview);
        continue;
      }
      if (!item.blob) continue;

      try {
        if (temporary) {
          const base64 = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result as string);
            reader.onerror = () => reject(new Error("Failed to read file"));
            reader.readAsDataURL(item.blob!);
          });
          urls.push(base64);
        } else {
          if (!supabase || !user) continue;
          const path = `${user.id}/msg/${crypto.randomUUID()}.jpg`;
          const { error: upErr } = await supabase.storage
            .from("covers")
            .upload(path, item.blob, { contentType: "image/jpeg", upsert: true });
          if (upErr) throw upErr;
          urls.push(supabase.storage.from("covers").getPublicUrl(path).data.publicUrl);
        }
      } catch (caught) {
        console.error("Image upload failed:", caught);
      }
    }
    return urls;
  }


  onSignedOutRef.current = newGame;

  function toggleRowMenu(id: string, event: MouseEvent<HTMLButtonElement>) {
    event.stopPropagation();
    setMenuOpenId((prev) => (prev === id ? null : id));
  }

  async function deleteTopicRow(chat: Chat, event?: MouseEvent<HTMLButtonElement>) {
    event?.stopPropagation();
    setMenuOpenId(null);
    if (
      !(await askConfirm(
        `Delete "${displayTopicTitle(resolvedTopicTitle(chat))}"? This cannot be undone.`,
        "Delete topic",
      ))
    ) {
      return;
    }
    const supabase = getSupabase();
    if (!supabase || !user) {
      removeLocalGame(chat.id);
      if (chat.id === activeChatId) {
        if (gameView === "thread") backToTopicList();
        else {
          setActiveChatId(null);
          setMessages([]);
        }
      }
      setChats(loadLocalGames());
      return;
    }
    const thread = await resolveThreadMessages(supabase, chat);
    const { error: deleteError } = await supabase.from("chats").delete().eq("id", chat.id);
    if (deleteError) {
      console.error("Failed to delete topic:", deleteError);
      setToast("Couldn't delete that topic. Try again.");
      return;
    }
    await removeCoverStoragePaths(supabase, threadImageStoragePaths(thread));
    setChats((prev) => prev.filter((row) => row.id !== chat.id));
    if (chat.id === activeChatId) {
      if (gameView === "thread") backToTopicList();
      else {
        activeChatIdRef.current = null;
        setActiveChatId(null);
        setMessages([]);
      }
    }
    void loadChats({ replace: true });
  }

  async function deleteAllTopics() {
    setMenuOpenId(null);
    const topics = topicsForRoom(chats, game, platform);
    if (topics.length === 0) return;
    if (
      !(await askConfirm(
        `Delete all ${topics.length} topics? Your guides and game info stay. This cannot be undone.`,
        "Delete all topics",
      ))
    ) {
      return;
    }
    const supabase = getSupabase();
    if (!supabase || !user) {
      const ids = new Set(topics.map((row) => row.id));
      for (const id of ids) removeLocalGame(id);
      if (activeChatId && ids.has(activeChatId)) {
        if (gameView === "thread") backToTopicList();
        else {
          setActiveChatId(null);
          setMessages([]);
        }
      }
      setChats(loadLocalGames());
      return;
    }
    const topicIds = new Set(topics.map((row) => row.id));
    for (const chat of topics) {
      const thread = await resolveThreadMessages(supabase, chat);
      const { error: deleteError } = await supabase.from("chats").delete().eq("id", chat.id);
      if (deleteError) {
        console.error("Failed to delete topic:", deleteError);
        setToast("Couldn't delete all topics. Try again.");
        void loadChats({ replace: true });
        return;
      }
      await removeCoverStoragePaths(supabase, threadImageStoragePaths(thread));
    }
    setChats((prev) => prev.filter((row) => !topicIds.has(row.id)));
    if (activeChatId && topicIds.has(activeChatId)) {
      backToTopicList();
    }
    void loadChats({ replace: true });
  }

  async function deleteGameRoom(chat: Chat, event?: MouseEvent<HTMLButtonElement>) {
    event?.stopPropagation();
    setMenuOpenId(null);
    const roomTopics = topicsForRoom(chats, chat.game, chat.platform);
    const label = chat.game || "Untitled game";
    const message =
      roomTopics.length > 1
        ? `Delete "${label}" and all ${roomTopics.length} topics? This cannot be undone.`
        : `Delete "${label}"? This cannot be undone.`;
    // ponytail: gate the forget-memory checkbox on the metadata flag, not a row-exists
    // query. If enabled but no memory for this game, checking it deletes nothing (fine).
    const memoryEnabled = Boolean(user && playerMemoryEnabledFromMetadata(user.user_metadata));
    let forgetMemory = false;
    if (memoryEnabled) {
      const { confirmed, checked } = await askConfirmWithCheckbox(
        `${message} Your saved progress and notes stay in Learn my style if you add this game again.`,
        {
          checkbox: { label: "Also forget saved memory for this game" },
          confirmLabel: "Delete game",
        },
      );
      if (!confirmed) return;
      forgetMemory = checked;
    } else if (!(await askConfirm(message, "Delete game"))) {
      return;
    }
    const supabase = getSupabase();
    if (!supabase || !user) {
      const ids = new Set(roomTopics.map((row) => row.id));
      const next = loadLocalGames().filter((row) => !ids.has(row.id));
      setLocalGames(next);
      if (activeChatId && ids.has(activeChatId)) newGame();
      else if (gameView === "topics" && game.trim()) {
        const stillHere = next.some(
          (row) =>
            row.game === chat.game &&
            row.platform === chat.platform,
        );
        if (!stillHere) newGame();
      }
      setChats(loadLocalGames());
      return;
    }
    const paths = new Set<string>();
    for (const row of roomTopics) {
      const thread = await resolveThreadMessages(supabase, row);
      for (const path of coverUrlsToStoragePaths([
        row.cover_url ?? "",
        ...thread.flatMap((message) =>
          Array.isArray(message.images) ? message.images : [],
        ),
      ])) {
        paths.add(path);
      }
      const { error: deleteError } = await supabase.from("chats").delete().eq("id", row.id);
      if (deleteError) {
        console.error("Failed to delete game room:", deleteError);
        setToast("Couldn't delete that game. Try again.");
        void loadChats({ replace: true });
        return;
      }
    }
    await removeCoverStoragePaths(supabase, [...paths]);
    if (forgetMemory && user) {
      try {
        await forgetGameMemory(supabase, user.id, normGameKey(chat.game), chat.platform || "");
      } catch (memoryError) {
        console.error("Failed to forget game memory:", memoryError);
      }
    }
    const roomIds = new Set(roomTopics.map((row) => row.id));
    setChats((prev) => prev.filter((row) => !roomIds.has(row.id)));
    const removedActive = activeChatId && roomTopics.some((row) => row.id === activeChatId);
    if (removedActive || (gameView === "topics" && game === chat.game && platform === chat.platform)) {
      newGame();
    }
    void loadChats({ replace: true });
  }

  async function deleteChat(chat: Chat, event?: MouseEvent<HTMLButtonElement>) {
    await deleteGameRoom(chat, event);
  }

  function activeChatRow(): Chat | null {
    const chatId = activeChatIdRef.current ?? activeChatId;
    if (!chatId) return null;
    return (
      chats.find((row) => row.id === chatId) ?? {
        id: chatId,
        game,
        platform,
        title: activeTopicTitle ?? "",
        messages,
        preferred_guide_url: preferredUrls[0] ?? "",
        preferred_guide_urls: preferredUrls,
        cover_url: cover,
        release_year: releaseYear,
        updated_at: new Date().toISOString(),
      }
    );
  }

  async function deleteActiveTopic() {
    setMenuOpenId(null);
    const chat = activeChatRow();
    if (chat) await deleteTopicRow(chat);
  }

  async function deleteActiveChat() {
    setMenuOpenId(null);
    const chat = activeChatRow();
    if (chat) {
      await deleteGameRoom(chat);
      return;
    }
    if (game.trim()) {
      await deleteGameRoom({
        id: "",
        game,
        platform,
        preferred_guide_url: preferredUrls[0] ?? "",
        preferred_guide_urls: preferredUrls,
        cover_url: cover,
        release_year: releaseYear,
        updated_at: new Date().toISOString(),
      });
      return;
    }
    if (await askConfirm("Discard this game?")) newGame();
  }

  async function renameTopic(chat: Chat) {
    setMenuOpenId(null);
    const current = resolvedTopicTitle(chat);
    const next = await askPrompt("Rename topic", current, "Save");
    if (next === null) return;
    const title = next.trim().slice(0, 120);
    const updated = { ...chat, title };

    setChats((prev) =>
      prev.map((row) => (row.id === chat.id ? updated : row)),
    );

    const supabase = getSupabase();
    if (!supabase || !user) {
      upsertLocalGame(updated);
      setChats(loadLocalGames());
      return;
    }
    let error = (await supabase.from("chats").update({ title }).eq("id", chat.id)).error;
    if (error && isTopicColumnDbError(error)) {
      saveTopicTitleById(chat.id, title);
      error = null;
    }
    if (error) {
      console.error("Failed to rename topic:", error);
      setToast("Couldn't rename topic. Try again.");
      void loadChats();
      return;
    }
    void loadChats();
  }

  const {
    persistChat,
    runTurn,
    stopGeneration,
    handleSubmit,
    startEdit,
    cancelEdit,
    saveEdit,
    retry,
    onNavigateVariant,
  } = useChatTurn({
    temporary,
    user,
    game,
    platform,
    preferredUrls,
    guideRetrievalMode,
    cover,
    releaseYear,
    messages,
    input,
    editingIndex,
    loading,
    guideMeta,
    guideIndexState,
    guidePending,
    spoilerPrefs,
    topicSpoilerMajor: gameSpoilerMajor,
    visualAuto,
    setActiveChatId,
    setChats,
    setMessages,
    setError,
    setRetryAction,
    setLoading,
    setGenerationStatus,
    setEditingIndex,
    setIndexingGuideCount,
    setGuideIndexState,
    setGuideMeta,
    setStatusRev,
    setConfirmFallbackModal,
    setEditingGame,
    setNewGameOpen,
    setOptPanel,
    setToast,
    setInput,
    setPendingImages,
    activeChatIdRef,
    variantScrollTargetRef,
    backgroundMessagesRef,
    backgroundLoadingRef,
    backgroundStatusRef,
    abortRefs,
    predictionIdsRef,
    conversationGame,
    composerRef,
    loadChats,
    resolveCoverUrl,
    uploadMessageImages,
    clearPendingImages,
    deleteMessageImages,
    askConfirm,
    applyIngestRowToMeta,
    normGameKey,
  });

  const clearActiveChat = useCallback(async () => {
    setMenuOpenId(null);
    if (!messages.length) return;
    if (
      !(await askConfirm(
        "Clear this chat history? Your game, guides, and cover stay saved.",
        "Clear chat",
      ))
    ) {
      return;
    }
    if (loading) return;

    await deleteMessageImages(messages);
    clearPendingImages();
    setEditingIndex(null);
    setInput("");
    setError("");
    setMessages([]);

    if (temporary) return;

    const chatId = activeChatIdRef.current;
    if (!chatId) {
      clearSessionDraft();
      return;
    }

    const supabase = getSupabase();
    if (supabase && user) {
      await clearNormalizedThread(supabase, chatId);
    }
    await persistChat([], chatId, { sync: "full" });
  }, [
    messages,
    loading,
    temporary,
    user,
    askConfirm,
    persistChat,
    clearPendingImages,
    deleteMessageImages,
  ]);

  const started =
    gameView !== null ||
    messages.length > 0 ||
    Boolean(activeChatId && game.trim()) ||
    editingGame;
  const hasGame = Boolean(game.trim());
  const showTopicList = gameView === "topics" && hasGame && !editingGame;
  const showThread =
    hasGame &&
    !editingGame &&
    gameView !== "topics" &&
    (gameView === "thread" || messages.length > 0 || Boolean(activeChatId));
  const composerLocked = loading || !hasGame || guideChecking || showTopicList;
  const gameRooms = groupChatsByRoom(chats);
  // Hide empty "save for later" topics from the list (the row still persists the
  // room's guides/cover). The room card + New topic remain; New topic reuses it.
  const roomTopics = (hasGame ? topicsForRoom(chats, game, platform) : []).filter(
    (t) => Array.isArray(t.messages) && t.messages.length > 0,
  );
  const activeRoomKey = hasGame && gameView !== null ? gameRoomKey(game, platform) : null;
  // Home layout states:
  // - Empty account: marketing hero + setup form (+ examples).
  // - Has saved games (quick home): hero + carousel + CTAs; "+ New game" collapses
  //   the hero and reveals the setup form below the carousel (push-up motion).
  const homeMode = !started && !editingGame;
  const hasRecent = homeMode && gameRooms.length > 0;
  const showCarousel = isMounted && hasRecent && !started;
  const quickIdle = showCarousel && !newGameOpen;
  const showHero = isMounted && homeMode;
  const showSetupForm =
    (isMounted && homeMode && (!hasRecent || newGameOpen)) || (started && editingGame);
  const QUICK_LIMIT = 7;
  const recentGames = gameRooms.slice(0, QUICK_LIMIT).map((room) => room.representative);
  const moreGamesCount = gameRooms.length - recentGames.length;
  const lastUserIndex = messages.map((m) => m.role).lastIndexOf("user");
  const lastGuideIndex = messages.map((m) => m.role).lastIndexOf("assistant");

  const showStickyHeader =
    showSticky && (showTopicList || messages.length > 0);

  const resolvedTopicTitleText = showThread
    ? activeChatId
      ? resolvedTopicTitle(chats.find((row) => row.id === activeChatId) ?? { messages })
      : titleFromMessages(messages)
    : "";

  const topicTitlePending =
    showThread &&
    shouldShowTopicTitleSkeleton({
      messages,
      loading,
      title: resolvedTopicTitleText,
    });

  const activeTopicTitle = showThread && !topicTitlePending
    ? displayTopicTitle(resolvedTopicTitleText)
    : "";

  const renderActiveGameCard = (menuVariant: "thread" | "topics") => (
    <ActiveGameCard
      topRef={topRef}
      coverEnabled={coverEnabled}
      cover={cover}
      game={game}
      platform={platform}
      releaseYear={releaseYear}
      activeChatId={menuVariant === "thread" ? activeChatId : null}
      temporary={menuVariant === "thread" ? temporary : false}
      loading={loading}
      menuOpenId={menuOpenId}
      preferredUrls={preferredUrls}
      guideMeta={guideMeta}
      guideIndexState={guideIndexState}
      showQuickAdd={showQuickAdd}
      guidePending={guidePending}
      retryingUrl={retryingUrl}
      isReindexingAll={isReindexingAll}
      gameSpoilerMajor={gameSpoilerMajor}
      user={user}
      menuVariant={menuVariant}
      topicCount={roomTopics.length}
      topicTitle={menuVariant === "thread" ? activeTopicTitle : undefined}
      topicTitlePending={menuVariant === "thread" ? topicTitlePending : false}
      className={menuVariant === "topics" ? "topic-list-game-card" : undefined}
      onToggleTemporary={() => void toggleTemporary()}
      onToggleRowMenu={toggleRowMenu}
      onEditGame={() => {
        setMenuOpenId(null);
        setEditingGame(true);
        scrollToTop();
      }}
      onNewTopic={startNewTopic}
      chatHasMessages={messages.length > 0}
      onClearActiveChat={() => void clearActiveChat()}
      onDeleteTopic={() => void deleteActiveTopic()}
      onDeleteActiveChat={() => void deleteActiveChat()}
      onDeleteAllTopics={() => void deleteAllTopics()}
      onSetShowQuickAdd={setShowQuickAdd}
      onPreferredUrlsChange={setPreferredUrls}
      onGuideMetaChange={setGuideMeta}
      onGuideCheckChange={setGuideChecking}
      onGuidePendingChange={setGuidePending}
      onRequestConfirm={(opts) => askConfirm(opts.message, opts.confirmLabel, opts.danger)}
      onSaveGameMeta={() => void saveGameMeta()}
      onRetryGuideIngest={(url) => void retryGuideIngest(url)}
      onReindexAllPending={() => void reindexAllPending()}
      onGameSpoilerChange={updateGameSpoiler}
    />
  );

  return (
    <main>
      <nav className="nav" aria-label="Brand">
        <div className="nav-left">
          {isMounted && (user || chats.length > 0) && (
            <button
              type="button"
              className="nav-icon-btn burger"
              aria-label="Open your games"
              aria-expanded={sidebarOpen}
              onClick={() => {
                setSidebarOpen(true);
                pushOverlayHistory();
              }}
            >
              <span aria-hidden="true" />
              <span aria-hidden="true" />
              <span aria-hidden="true" />
            </button>
          )}
          <a
            className="brand"
            href="#"
            aria-label="Game Guide Go, home"
            onClick={(event) => {
              event.preventDefault();
              goHome();
            }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img className="brand-mark" src="/logo.png" alt="" width={38} height={38} />
            <span>GAME GUIDE GO</span>
          </a>
        </div>

        <div className="nav-actions">
          <ProfileMenu
            user={user}
            supabaseReady={supabaseReady}
            spoilerMajor={globalSpoilerMajor}
            onSpoilerChange={updateGlobalSpoiler}
            visualAuto={visualAuto}
            onVisualAutoChange={setVisualAuto}
            navMenu={navMenu}
            onNavMenuChange={handleNavMenuChange}
            onNavMenuNavigate={closeNavMenuForNav}
            onSignIn={() => {
              if (navMenu) dismissNavMenu();
              setAuthOpen(true);
              pushOverlayHistory();
            }}
            onSignOut={() => void signOut()}
          />
          {!user && !supabaseReady && (
            <span className="live-badge">
              <span aria-hidden="true" />
              WEB LIVE
            </span>
          )}
        </div>
      </nav>

      <GamesSidebar
        visible={Boolean(user || chats.length > 0)}
        user={user}
        chats={gameRooms.map((room) => room.representative)}
        activeChatId={activeChatId}
        activeRoomKey={activeRoomKey}
        sidebarOpen={sidebarOpen}
        libraryOpen={libraryOpen}
        steamLibraryOpen={steamLibraryOpen}
        steamConnected={steamConnected}
        steamId={steamId}
        menuOpenId={menuOpenId}
        librarySearch={librarySearch}
        onDismissOverlay={dismissOverlay}
        onCloseSidebar={() => {
          if (!sidebarOpen) return;
          dismissOverlay();
        }}
        onGoHome={() => {
          // newGame() resets straight to the home view and closes the sidebar.
          // We don't route through goHome()'s history.back() here: the open
          // sidebar pushed its own overlay entry, so a single back() would just
          // close the sidebar and stay in the chat.
          // ponytail: the pushed chat/overlay entries linger in history, so a
          // hardware-back from home can dead-click once; fix with an explicit
          // history unwind if it ever bothers anyone.
          newGame();
        }}
        showBackToGame={showThread}
        onBackToGame={() => {
          setSidebarOpen(false);
          setMenuOpenId(null);
          backToTopicList();
        }}
        onOpenSavedLibrary={openSavedLibrary}
        onConnectSteam={connectSteam}
        onOpenSteamLibrary={openSteamLibrary}
        onOpenChat={openGameRoom}
        onToggleRowMenu={toggleRowMenu}
        onEditGame={editGame}
        onDeleteChat={deleteChat}
        onStartNewGame={startNewGame}
        onLibrarySearchChange={setLibrarySearch}
        onOpenFromLibrary={openFromLibrary}
        onEditFromLibrary={editFromLibrary}
        onPickSteamGame={startFromSteamGame}
      />

      {(showThread || showTopicList) && showStickyHeader && (
        <div
          className={`sticky-header${spoilerPrefs.major ? " spoilers-on" : ""}`}
          onClick={scrollToTop}
          role="button"
          tabIndex={0}
          aria-label="Scroll to top"
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              scrollToTop();
            }
          }}
        >
          <button
            type="button"
            className="nav-icon-btn burger"
            onClick={(event) => {
              event.stopPropagation();
              setSidebarOpen(true);
              pushOverlayHistory();
            }}
            aria-label="Open your games"
            aria-expanded={sidebarOpen}
          >
            <span aria-hidden="true" />
            <span aria-hidden="true" />
            <span aria-hidden="true" />
          </button>
          {coverEnabled && <CoverThumb cover={cover} name={game} className="cover-mini" />}
          <div className="sticky-meta">
            <strong>{game || "Untitled game"}</strong>
            {showThread && (topicTitlePending || activeTopicTitle) ? (
              <TopicTitleTypewriter
                as="small"
                className="sticky-topic-title"
                title={activeTopicTitle}
                pending={topicTitlePending}
              />
            ) : (platform || releaseYear || game) ? (
              <small className="meta-subline">
                {displayPlatform(platform, cover) && (
                  <span className="meta-chunk">{displayPlatform(platform, cover)}</span>
                )}
                {displayPlatform(platform, cover) && releaseYear && (
                  <span className="meta-dot" aria-hidden>
                    ·
                  </span>
                )}
                {releaseYear && <span className="meta-chunk">{releaseYear}</span>}
                <HltbRow
                  title={game}
                  appId={steamAppIdFromCoverUrl(cover)?.toString()}
                  variant="inline"
                  sep={Boolean(displayPlatform(platform, cover) || releaseYear)}
                />
                {spoilerPrefs.major && (
                  <>
                    <span className="meta-dot" aria-hidden>
                      ·
                    </span>
                    <button
                      type="button"
                      className="meta-chunk meta-chunk-spoilers"
                      title={SPOILER_MODE_OFF_TITLE}
                      aria-label={SPOILER_MODE_OFF_TITLE}
                      disabled={loading}
                      onClick={(event) => {
                        event.stopPropagation();
                        turnOffSpoilers();
                      }}
                    >
                      {SPOILER_MODE_ON_LABEL}
                    </button>
                  </>
                )}
              </small>
            ) : null}
          </div>
          {activeChatId && !temporary && (
            <button
              type="button"
              className="sticky-incognito"
              title="Start a temporary chat"
              aria-label="Start a temporary chat"
              disabled={loading}
              onClick={(event) => {
                event.stopPropagation();
                void toggleTemporary();
              }}
            >
              <IconIncognito size={18} />
            </button>
          )}
        </div>
      )}

      <HomeSetup
        showHero={showHero}
        showCarousel={showCarousel}
        showSetupForm={showSetupForm}
        hasRecent={hasRecent}
        newGameOpen={newGameOpen}
        editingGame={editingGame}
        topRef={topRef}
        recentGames={recentGames}
        moreGamesCount={moreGamesCount}
        steamConnected={steamConnected}
        coverEnabled={coverEnabled}
        cover={cover}
        pendingCover={pendingCover}
        game={game}
        platform={platform}
        preferredUrls={preferredUrls}
        optPanel={optPanel}
        loading={loading}
        uploadingCover={uploadingCover}
        guideMeta={guideMeta}
        guideIndexState={guideIndexState}
        guidePending={guidePending}
        gameSpoilerMajor={gameSpoilerMajor}
        user={user}
        onOpenChat={openGameRoom}
        onOpenSavedLibrary={openSavedLibrary}
        onStartNewGame={startNewGame}
        onOpenSteamLibrary={openSteamLibrary}
        onSetNewGameOpen={(open) => {
          if (open) setNewGameOpen(true);
          else closeNewGameForm();
        }}
        onSetOptPanel={setOptPanel}
        onGameChange={handleGameChange}
        onPickGame={pickGame}
        onPlatformChange={setPlatform}
        onSelectCover={selectCover}
        onClearCover={clearCover}
        onPreferredUrlsChange={setPreferredUrls}
        onGuideMetaChange={setGuideMeta}
        onGuideCheckChange={setGuideChecking}
        onGuidePendingChange={setGuidePending}
        onRequestConfirm={(opts) => askConfirm(opts.message, opts.confirmLabel, opts.danger)}
        onGameSpoilerChange={updateGameSpoiler}
        onSaveGameMeta={() => void saveGameMeta()}
        onSaveNewGame={() => void saveNewGame()}
      />

      {showTopicList ? (
        <div className="topic-list-shell">
          <TopicList
            headerBefore={renderActiveGameCard("topics")}
            topics={roomTopics}
            menuOpenId={menuOpenId}
            loading={loading}
            onNewTopic={startNewTopic}
            onOpenTopic={(topic) => void openChat(topic)}
            onToggleRowMenu={toggleRowMenu}
            onRenameTopic={(topic) => void renameTopic(topic)}
            onDeleteTopic={(topic) => void deleteTopicRow(topic)}
          />
          <HomeTip />
        </div>
      ) : null}

      {showThread ? renderActiveGameCard("thread") : null}

      {showThread ? (
        <MessageList
          messages={messages}
          loading={loading}
          error={error}
          retryAction={retryAction}
          editingIndex={editingIndex}
          spoilerMajor={spoilerPrefs.major}
          generationStatus={generationStatus}
          indexingGuideCount={indexingGuideCount}
          preferredUrlCount={preferredUrls.length}
          guideMeta={guideMeta}
          lastUserIndex={lastUserIndex}
          lastGuideIndex={lastGuideIndex}
          lastUserRef={lastUserRef}
          lastGuideRef={lastGuideRef}
          feedRef={feedRef}
          editSlotRef={setEditSlotEl}
          onStartEdit={startEdit}
          onRetry={retry}
          onNavigateVariant={onNavigateVariant}
          onOpenLightbox={(images, index) => setLightboxState({ images, index })}
          onAddGuide={() => {
            setShowQuickAdd(true);
            scrollToTop();
          }}
          guideUpsellDismissed={guideNudgeDismissed}
          onDismissGuideUpsell={() => {
            dismissGuideNudge(game);
            setGuideNudgeDismissed(true);
          }}
        />
      ) : null}

      {showThread && (
        <button
          type="button"
          className={`scroll-to-bottom-fab${showScrollFab ? " visible" : ""}`}
          aria-label="Jump to latest message"
          aria-hidden={!showScrollFab}
          tabIndex={showScrollFab ? 0 : -1}
          onClick={scrollToLatest}
        >
          <IconChevronDown />
        </button>
      )}

      <Lightbox 
        images={lightboxState?.images || []} 
        initialIndex={lightboxState?.index || 0}
        onClose={() => setLightboxState(null)} 
      />

      {/* Composer is useless in the idle carousel state (no game field visible);
          it returns once "+ New game" reveals the setup form.
          While editing, the composer is portaled into the message slot
          (editSlotEl) so it replaces the green bubble in place. Input/images
          live in page state so they survive the docked<->portal switch;
          startEdit's setTimeout(0) re-focuses the textarea after it mounts. */}
      {!quickIdle && !showTopicList &&
        (() => {
          const composer = (
        <ComposerShell
          started={started}
          temporary={temporary}
          spoilerMajor={spoilerPrefs.major}
          inlineEdit={editingIndex !== null}
          dragActive={dragActive}
          composerLocked={composerLocked}
          coverEnabled={coverEnabled}
          hasGame={hasGame}
          preferredUrlCount={preferredUrls.length}
          input={input}
          editingIndex={editingIndex}
          loading={loading}
          isExpanded={isExpanded}
          voiceListening={voiceListening}
          voiceSupported={voiceSupported}
          maxMessageImages={MAX_MESSAGE_IMAGES}
          pendingImages={pendingImages}
          user={user}
          composerRef={composerRef}
          onSubmit={handleSubmit}
          onInputChange={setInput}
          onDragActiveChange={setDragActive}
          onSelectImages={selectMessageImages}
          onRemovePendingImage={removePendingImage}
          onOpenLightbox={(images, index) => setLightboxState({ images, index })}
          onToggleTemporary={() => void toggleTemporary()}
          onToggleSpoiler={toggleEffectiveSpoiler}
          showGuideRetrievalToggles={preferredUrls.length > 0}
          guideRetrievalMode={guideRetrievalMode}
          onToggleSkipGuide={toggleSkipGuide}
          onToggleSupplementGuide={toggleSupplementGuide}
          onVoiceListeningChange={setVoiceListening}
          onVoiceTranscript={(text) =>
            setInput((prev) => (prev.trim() ? `${prev.trim()} ${text}` : text))
          }
          onStopGeneration={stopGeneration}
          onCancelEdit={cancelEdit}
        />
          );
          if (editingIndex !== null) {
            return editSlotEl ? createPortal(composer, editSlotEl) : null;
          }
          return composer;
        })()}
      {/* Ambient quick-home tip. On the pure carousel it sticks to the screen
          bottom (composer/examples/disclaimer are all hidden, so it's the last
          flow child). On "+ New game" it renders after the composer as static
          flow so it never sits above and distracts from the input. */}
      {showCarousel && <HomeTip anchored={newGameOpen} />}
      {!hasRecent && homeMode && !examplesDismissed && (
        <div className="examples-block" aria-label="Examples">
          <div className="examples-head">
            <span className="examples-label">Try an example</span>
            <button
              type="button"
              className="examples-dismiss"
              aria-label="Hide examples"
              onClick={dismissExamples}
            >
              <IconX />
            </button>
          </div>
          <div className="examples">
            {examples.map((example) => (
              <button
                key={example.q}
                type="button"
                onClick={() => {
                  setGame(example.game);
                  setPlatform(example.platform);
                  setInput(example.q);
                }}
                disabled={loading}
              >
                <strong>{example.game}</strong>
                <span>{example.q}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {!quickIdle && !showTopicList && (
        <p className="disclaimer">
          Guides are summarized by AI. Check the sources for version-specific details.
        </p>
      )}

      {authOpen && <AuthPanel onClose={dismissOverlay} />}

      {confirmFallbackModal && (
        <div
          className="confirm-overlay"
          role="presentation"
        >
          <div className="confirm-modal" role="dialog" aria-modal="true">
            <p className="confirm-message">{confirmFallbackModal.hint}</p>
            <div className="confirm-actions">
              <button
                type="button"
                className="confirm-cancel"
                onClick={confirmFallbackModal.onCancel}
              >
                Change Guide
              </button>
              <button
                type="button"
                className="confirm-confirm"
                onClick={confirmFallbackModal.onConfirm}
              >
                {confirmFallbackModal.hasIndexedGuides ? "Use Indexed Guides" : "Search Web"}
              </button>
            </div>
          </div>
        </div>
      )}

      {confirmState ? (
        <ConfirmDialog
          state={confirmState}
          onCancel={() => closeConfirm(false)}
          onConfirm={(checked) => closeConfirm(true, checked)}
        />
      ) : null}

      {promptState && (
        <PromptDialog
          label={promptState.label}
          confirmLabel={promptState.confirmLabel}
          draft={promptDraft}
          inputRef={promptInputRef}
          onDraftChange={setPromptDraft}
          onCancel={() => closePrompt(null)}
          onSave={() => closePrompt()}
        />
      )}

      {toast && (
        <div className="snackbar" role="status" aria-live="polite">
          {toast}
        </div>
      )}
    </main>
  );
}
