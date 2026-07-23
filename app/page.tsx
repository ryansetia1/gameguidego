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
  resolveThreadMessages,
} from "@/lib/chat-thread-persist.js";
import {
  guideUrlsFromChat,
  guideUrlsPayload,
  normalizeGuideUrlList,
} from "@/lib/guide-urls.js";
import { compressImage } from "@/lib/image.js";
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
  saveGameSpoilerPrefs,
  saveGlobalSpoilerPrefs,
  SPOILER_MODE_OFF_TITLE,
  SPOILER_MODE_ON_LABEL,
  spoilerMajorFromUserMetadata,
} from "@/lib/spoiler-prefs.js";
import { getSupabase, type Chat } from "@/lib/supabase";
import {
  loadLocalGames,
  removeLocalGame,
  upsertLocalGame,
} from "@/lib/local-games.js";
import { steamAppIdFromCoverUrl, steamIdFromMetadata } from "@/lib/steam.js";
import { dismissGuideNudge, isGuideNudgeDismissed } from "@/lib/guide-nudge.js";
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

function normGame(value: string) {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

const COVERS_MARKER = "/storage/v1/object/public/covers/";
function coverStoragePath(url: string): string | null {
  const at = url.indexOf(COVERS_MARKER);
  return at === -1 ? null : url.slice(at + COVERS_MARKER.length);
}

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
  const [indexingIsBundlePages, setIndexingIsBundlePages] = useState(false);
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
  // Temporary chat: lives only in memory, never written to Supabase/localStorage/
  // sessionStorage, so a refresh or close wipes it. Follow-ups still work (they
  // read from `messages` state, not storage).
  const [temporary, setTemporary] = useState(false);
  const [authOpen, setAuthOpen] = useState(false);
  const [navMenu, setNavMenu] = useState<NavMenu>(null);
  const navMenuRef = useRef<NavMenu>(null);
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
  const spoilerPrefs = effectiveSpoilerPrefs(globalSpoilerMajor, gameSpoilerMajor);
  const [voiceListening, setVoiceListening] = useState(false);
  const [voiceSupported, setVoiceSupported] = useState(false);
  const [librarySearch, setLibrarySearch] = useState("");
  const [confirmState, setConfirmState] = useState<{
    message: string;
    confirmLabel?: string;
    danger?: boolean;
    resolve: (value: boolean) => void;
  } | null>(null);
  const [toast, setToast] = useState("");
  const [lastLibrary, setLastLibrary] = useState<"saved" | "steam">("saved");

  // Promise-based confirm dialog. Declared up here so the Steam return effect can
  // offer "Use your Steam account" without a declaration-order tangle.
  const askConfirm = useCallback(
    (message: string, confirmLabel?: string, danger = true) =>
      new Promise<boolean>((resolve) =>
        setConfirmState({ message, confirmLabel, danger, resolve }),
      ),
    [],
  );

  const feedRef = useRef<HTMLDivElement>(null);
  const lastUserRef = useRef<HTMLDivElement>(null);
  const lastGuideRef = useRef<HTMLElement>(null);
  const topRef = useRef<HTMLElement>(null);
  const jumpRef = useRef(false);
  const variantScrollTargetRef = useRef<number | null>(null);
  const chatHistoryPushed = useRef(false);
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
  const activeChatIdRef = useRef<string | null>(null);
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

  function dismissOverlay() {
    if (typeof window === "undefined") return;
    window.history.back();
  }

  function dismissNavMenu() {
    if (!navMenuRef.current) return;
    // ponytail: popstate closes the menu (like sidebar/library). Clearing state
    // before history.back() lets the handler see navMenu=null and show exit toast.
    dismissOverlay();
  }

  function handleNavMenuChange(menu: NavMenu) {
    if (menu === null) {
      dismissNavMenu();
      return;
    }
    const hadMenu = navMenu !== null;
    setNavMenu(menu);
    if (!hadMenu) pushOverlayHistory();
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
    guideBundleMeta,
    setGuideBundleMeta,
    bundleIndexStatus,
    bundlePanelLoad,
    guideIndexState,
    setGuideIndexState,
    setBundleStatusRev,
    guideChecking,
    setGuideChecking,
    guidePending,
    setGuidePending,
    retryingBundleUrl,
    refreshingBundleUrl,
    isReindexingAll,
    bundlePageTotal,
    applyIngestRowToMeta,
    retryBundleIngest,
    handleSkipBundlePage,
    handleUnskipBundlePage,
    handleSkipAllMissingBundlePages,
    refreshBundleDiscovery,
    reindexAllPending,
    resetGuideBundle,
    startBundleIndexingPoll,
    stopBundleIndexingPoll,
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
      // No overlay open: a back press from a game thread returns to the home page.
      if (messages.length > 0) {
        chatHistoryPushed.current = false;
        homeExitPromptAt.current = 0;
        newGame();
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
    messages.length,
    confirmFallbackModal,
    navMenu,
    newGameOpen,
    editingGame,
  ]);

  // Give the browser a history entry to pop when a chat thread is showing, so the
  // hardware/gesture back returns home instead of leaving the app.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (messages.length > 0 && !chatHistoryPushed.current) {
      chatHistoryPushed.current = true;
      window.history.pushState({ gggChat: true }, "");
    } else if (messages.length === 0) {
      chatHistoryPushed.current = false;
    }
  }, [messages.length]);

  // Arm hardware back on home idle so the first press shows a leave hint instead
  // of exiting the PWA immediately. Only seed when the stack top has no guard
  // entry yet (overlay/chat close already leaves gggHomeRoot underneath).
  useEffect(() => {
    if (typeof window === "undefined") return;
    const arm =
      messages.length === 0 &&
      !newGameOpen &&
      !editingGame &&
      !authOpen &&
      !navMenu &&
      !sidebarOpen &&
      !libraryOpen &&
      !steamLibraryOpen;
    if (!arm) {
      if (messages.length > 0 || newGameOpen) homeExitPromptAt.current = 0;
      return;
    }
    const top = window.history.state as { gggHomeRoot?: boolean; gggOverlay?: boolean; gggChat?: boolean } | null;
    if (top?.gggHomeRoot || top?.gggOverlay || top?.gggChat) return;
    window.history.pushState({ gggHomeRoot: true }, "");
  }, [
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
  }, [activeChatId]);

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

  const loadChats = useCallback(async () => {
    const supabase = getSupabase();
    if (!supabase || !userRef.current) {
      setChats(loadLocalGames());
      return;
    }
    const { data, error: loadError } = await supabase
      .from("chats")
      .select(
        "id, game, platform, preferred_guide_url, preferred_guide_urls, cover_url, release_year, updated_at, messages",
      )
      .order("updated_at", { ascending: false });
    if (!loadError && data) setChats(data as Chat[]);
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
      setActiveChatId(draft.activeChatId);
      setGame(draft.game);
      setPlatform(draft.platform);
      setPreferredUrls(draft.preferredUrls);
      setCover(draft.cover);
      setPendingCover(null);
      replacedCoverRef.current = null;
      clearPendingImages();
      setReleaseYear(draft.releaseYear);
      setEditingGame(false);
      setMessages(parseStoredMessages(draft.messages));
      conversationGame.current = draft.game;
      setInput("");
      setError("");
      setEditingIndex(null);
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
    });
  }, [messages, activeChatId, game, platform, preferredUrls, cover, releaseYear, user, temporary]);

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

  useEffect(() => {
    if (!confirmState) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        confirmState!.resolve(false);
        setConfirmState(null);
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [confirmState]);

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
      authOpen || navMenu !== null || confirmState !== null || editingGame || editingIndex !== null;
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
    editingGame,
    editingIndex,
    steamConnected,
    lastLibrary,
  ]);

  useEffect(() => {
    setGlobalSpoilerMajor(loadGlobalSpoilerPrefs().major);
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

  useEffect(() => {
    if (!game.trim()) {
      setGameSpoilerMajor(false);
      return;
    }
    setGameSpoilerMajor(loadGameSpoilerPrefs(game).major);
  }, [game]);

  const updateGlobalSpoiler = useCallback((value: boolean) => {
    setGlobalSpoilerMajor(value);
    saveGlobalSpoilerPrefs({ major: value });
  }, []);

  const updateGameSpoiler = useCallback(
    (value: boolean) => {
      setGameSpoilerMajor(value);
      if (game.trim()) saveGameSpoilerPrefs(game, { major: value });
    },
    [game],
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
    if (editingIndex === null) return;
  }, [editingIndex]);

  // Show the compact sticky header once the game card/fields scroll out of view.
  useEffect(() => {
    const element = topRef.current;
    if (!element) {
      setShowSticky(false);
      return;
    }
    const observer = new IntersectionObserver(
      ([entry]) => setShowSticky(!entry.isIntersecting),
      { threshold: 0 },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [messages.length, editingGame]);

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
    setChatUrl(null);
    clearSessionDraft();
    setActiveChatId(null);
    setMessages([]);
    setGame("");
    setPlatform("");
    setPreferredUrls([]);
    resetGuideBundle();
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
    setSidebarOpen(false);
    setMenuOpenId(null);
    setTemporary(false);
    newGameHistoryPushed.current = false;
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
      };
      clearTransient();
      setMessages([]);
      setActiveChatId(null);
      conversationGame.current = "";
      clearSessionDraft();
      setChatUrl(null);
      setTemporary(true);
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
      // Restore the saved-chat deep link so a later refresh reopens it.
      if (prior.activeChatId && user) setChatUrl(prior.activeChatId);
    } else {
      setMessages([]);
      setActiveChatId(null);
      conversationGame.current = "";
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

  function commitOpenChat(chat: Chat, loaded: Message[], isBgLoading: boolean) {
    jumpRef.current = true;
    setChatUrl(chat.id);
    clearSessionDraft();
    setActiveChatId(chat.id);
    setGame(chat.game);
    setPlatform(chat.platform);
    setPreferredUrls(guideUrlsFromChat(chat));
    if (cover.startsWith("blob:")) URL.revokeObjectURL(cover);
    setCover(chat.cover_url ?? "");
    setPendingCover(null);
    replacedCoverRef.current = null;
    clearPendingImages();
    setReleaseYear(chat.release_year ?? "");
    setEditingGame(false);
    setMessages(loaded);
    setLoading(isBgLoading || false);
    setGenerationStatus(backgroundStatusRef.current[chat.id] || null);
    conversationGame.current = chat.game;
    setInput("");
    setError("");
    setEditingIndex(null);
    setSidebarOpen(false);
    setMenuOpenId(null);
    setTemporary(false);
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
    const id = activeChatIdRef.current;
    if (supabase && id) {
      await supabase.from("chats").update({ cover_url: "" }).eq("id", id);
      void loadChats();
    }
    // Remove the old uploaded cover file(s) too (skips TheGamesDB CDN covers).
    if (supabase && toRemove.length) {
      try {
        await supabase.storage.from("covers").remove(toRemove);
      } catch (caught) {
        console.error("Cover cleanup failed:", caught);
      }
    }
  }

  async function saveGameMeta() {
    setEditingGame(false);
    conversationGame.current = game;
    const urls = normalizeGuideUrlList(preferredUrls);
    setPreferredUrls(urls);
    const supabase = getSupabase();
    const id = activeChatIdRef.current;
    if (!id) return;
    // Anon: update the local entry's metadata in place.
    if (!supabase || !user) {
      const existing = loadLocalGames().find((row) => row.id === id);
      if (existing) {
        upsertLocalGame({
          ...existing,
          game,
          platform,
          ...guideUrlsPayload(urls),
          release_year: releaseYear,
          updated_at: new Date().toISOString(),
        });
        setChats(loadLocalGames());
      }
      return;
    }
    try {
      const coverUrl = await resolveCoverUrl();
      await supabase
        .from("chats")
        .update({
          game,
          platform,
          ...guideUrlsPayload(urls),
          cover_url: coverUrl,
          release_year: releaseYear,
          updated_at: new Date().toISOString(),
        })
        .eq("id", id);
      void loadChats();
    } catch (caught) {
      console.error("Failed to save game details:", caught);
    }
  }

  function editGame(chat: Chat, event: MouseEvent<HTMLButtonElement>) {
    event.stopPropagation();
    openChat(chat);
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

  // Return to the empty home view. Pop the pushed chat entry so the history stack
  // matches a hardware back (popstate then runs newGame); fall back to a direct
  // reset if nothing was pushed.
  function goHome() {
    if (chatHistoryPushed.current) window.history.back();
    else newGame();
  }

  // Promise-based confirm dialog (replaces window.confirm): resolves true/false
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
    openChat(chat);
    if (libraryOpen) dismissOverlay();
    else setLibraryOpen(false);
  }

  function editFromLibrary(chat: Chat) {
    setMenuOpenId(null);
    openFromLibrary(chat);
    setEditingGame(true);
  }


  function startFromSteamGame(game: SteamGame) {
    if (steamLibraryOpen) dismissOverlay();
    else setSteamLibraryOpen(false);
    setSidebarOpen(false);
    setLibraryOpen(false);

    const existing = chats.find(
      (chat) =>
        chat.game.toLowerCase() === game.name.toLowerCase() &&
        (chat.platform === "PC" || !chat.platform),
    );
    if (existing) {
      openChat(existing);
      return;
    }

    jumpRef.current = true;
    setActiveChatId(null);
    setMessages([]);
    setGame(game.name);
    setPlatform("PC");
    setPreferredUrls([]);
    resetGuideBundle();
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
        const id = activeChatIdRef.current;
        const supabase = getSupabase();
        if (id && supabase && user) {
          await supabase
            .from("chats")
            .update({ release_year: data.year, updated_at: new Date().toISOString() })
            .eq("id", id);
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

  async function deleteChat(chat: Chat, event?: MouseEvent<HTMLButtonElement>) {
    event?.stopPropagation();
    setMenuOpenId(null);
    if (
      !(await askConfirm(
        `Delete "${chat.game || "Untitled game"}"? This cannot be undone.`,
      ))
    ) {
      return;
    }
    const supabase = getSupabase();
    // Anon: no Storage files to clean up — just drop the local entry.
    if (!supabase || !user) {
      removeLocalGame(chat.id);
      if (chat.id === activeChatId) newGame();
      setChats(loadLocalGames());
      return;
    }
    const thread = await resolveThreadMessages(supabase, chat);
    const urls = [
      chat.cover_url ?? "",
      ...thread.flatMap((message) =>
        Array.isArray(message.images) ? message.images : [],
      ),
    ];
    const paths = urls
      .map(coverStoragePath)
      .filter((path): path is string => Boolean(path));
    await supabase.from("chats").delete().eq("id", chat.id);
    if (paths.length) {
      try {
        await supabase.storage.from("covers").remove(paths);
      } catch (caught) {
        console.error("Storage cleanup failed:", caught);
      }
    }
    if (chat.id === activeChatId) newGame();
    void loadChats();
  }

  // Delete the chat currently shown in the game card. Unsaved drafts (no row yet)
  // just discard back to home.
  async function deleteActiveChat() {
    setMenuOpenId(null);
    const chat = chats.find((c) => c.id === activeChatIdRef.current);
    if (chat) {
      await deleteChat(chat);
      return;
    }
    if (await askConfirm("Discard this game?")) newGame();
  }

  const {
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
    cover,
    releaseYear,
    messages,
    input,
    editingIndex,
    loading,
    guideBundleMeta,
    bundleIndexStatus,
    guideIndexState,
    guidePending,
    spoilerPrefs,
    setActiveChatId,
    setChats,
    setMessages,
    setError,
    setRetryAction,
    setLoading,
    setGenerationStatus,
    setEditingIndex,
    setIndexingIsBundlePages,
    setIndexingGuideCount,
    setGuideIndexState,
    setGuideBundleMeta,
    setBundleStatusRev,
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
    startBundleIndexingPoll,
    stopBundleIndexingPoll,
    normGame,
  });

  const started = messages.length > 0;
  const hasGame = Boolean(game.trim());
  const composerLocked = loading || !hasGame || guideChecking;
  // Home layout states:
  // - Empty account: marketing hero + setup form (+ examples).
  // - Has saved games (quick home): hero + carousel + CTAs; "+ New game" collapses
  //   the hero and reveals the setup form below the carousel (push-up motion).
  const homeMode = !started && !editingGame;
  const hasRecent = homeMode && chats.length > 0;
  const showCarousel = isMounted && hasRecent && !started;
  const quickIdle = showCarousel && !newGameOpen;
  const showHero = isMounted && homeMode;
  const showSetupForm =
    (isMounted && homeMode && (!hasRecent || newGameOpen)) || (started && editingGame);
  const QUICK_LIMIT = 7;
  const recentGames = chats.slice(0, QUICK_LIMIT);
  const moreGamesCount = chats.length - recentGames.length;
  const lastUserIndex = messages.map((m) => m.role).lastIndexOf("user");
  const lastGuideIndex = messages.map((m) => m.role).lastIndexOf("assistant");

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
            navMenu={navMenu}
            onNavMenuChange={handleNavMenuChange}
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
        chats={chats}
        activeChatId={activeChatId}
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
        onOpenSavedLibrary={openSavedLibrary}
        onConnectSteam={connectSteam}
        onOpenSteamLibrary={openSteamLibrary}
        onOpenChat={openChat}
        onToggleRowMenu={toggleRowMenu}
        onEditGame={editGame}
        onDeleteChat={deleteChat}
        onStartNewGame={startNewGame}
        onLibrarySearchChange={setLibrarySearch}
        onOpenFromLibrary={openFromLibrary}
        onEditFromLibrary={editFromLibrary}
        onPickSteamGame={startFromSteamGame}
      />

      {started && showSticky && (
        <div
          className="sticky-header"
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
            {(platform || releaseYear || game) && (
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
            )}
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
        guideBundleMeta={guideBundleMeta}
        guideIndexState={guideIndexState}
        guidePending={guidePending}
        gameSpoilerMajor={gameSpoilerMajor}
        user={user}
        onOpenChat={openChat}
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
        onBundleMetaChange={setGuideBundleMeta}
        onGuideCheckChange={setGuideChecking}
        onGuidePendingChange={setGuidePending}
        onRequestConfirm={(opts) =>
          new Promise((resolve) => setConfirmState({ ...opts, resolve }))
        }
        onGameSpoilerChange={updateGameSpoiler}
        onSaveGameMeta={() => void saveGameMeta()}
      />

      {started && !editingGame ? (
        <ActiveGameCard
          topRef={topRef}
          coverEnabled={coverEnabled}
          cover={cover}
          game={game}
          platform={platform}
          releaseYear={releaseYear}
          activeChatId={activeChatId}
          temporary={temporary}
          loading={loading}
          menuOpenId={menuOpenId}
          preferredUrls={preferredUrls}
          guideBundleMeta={guideBundleMeta}
          bundleIndexStatus={bundleIndexStatus}
          bundlePanelLoad={bundlePanelLoad}
          guideIndexState={guideIndexState}
          showQuickAdd={showQuickAdd}
          guidePending={guidePending}
          retryingBundleUrl={retryingBundleUrl}
          refreshingBundleUrl={refreshingBundleUrl}
          isReindexingAll={isReindexingAll}
          gameSpoilerMajor={gameSpoilerMajor}
          user={user}
          onToggleTemporary={() => void toggleTemporary()}
          onToggleRowMenu={toggleRowMenu}
          onEditGame={() => {
            setMenuOpenId(null);
            setEditingGame(true);
            scrollToTop();
          }}
          onDeleteActiveChat={() => void deleteActiveChat()}
          onSetShowQuickAdd={setShowQuickAdd}
          onPreferredUrlsChange={setPreferredUrls}
          onBundleMetaChange={setGuideBundleMeta}
          onGuideCheckChange={setGuideChecking}
          onGuidePendingChange={setGuidePending}
          onRequestConfirm={(opts) =>
            new Promise((resolve) => setConfirmState({ ...opts, resolve }))
          }
          onSaveGameMeta={() => void saveGameMeta()}
          onRetryBundleIngest={(url) => void retryBundleIngest(url)}
          onSkipBundlePage={handleSkipBundlePage}
          onUnskipBundlePage={handleUnskipBundlePage}
          onSkipAllMissingBundlePages={(url, slugs) =>
            handleSkipAllMissingBundlePages(url, slugs)
          }
          onRefreshBundleDiscovery={(url) => void refreshBundleDiscovery(url)}
          onReindexAllPending={() => void reindexAllPending()}
          onGameSpoilerChange={updateGameSpoiler}
        />
      ) : null}

      
      {started && (
        <MessageList
          messages={messages}
          loading={loading}
          error={error}
          retryAction={retryAction}
          editingIndex={editingIndex}
          spoilerMajor={spoilerPrefs.major}
          generationStatus={generationStatus}
          indexingGuideCount={indexingGuideCount}
          indexingIsBundlePages={indexingIsBundlePages}
          bundlePageTotal={bundlePageTotal}
          preferredUrlCount={preferredUrls.length}
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
      )}

      {started && (
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
      {!quickIdle &&
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

      {!quickIdle && (
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

      {confirmState && (
        <div
          className="confirm-overlay"
          role="presentation"
        >
          <div className="confirm-modal" role="dialog" aria-modal="true">
            <p className="confirm-message">{confirmState.message}</p>
            <div className="confirm-actions">
              <button
                type="button"
                className="confirm-cancel"
                onClick={() => {
                  confirmState.resolve(false);
                  setConfirmState(null);
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                className={confirmState.danger === false ? "confirm-confirm" : "confirm-delete"}
                onClick={() => {
                  confirmState.resolve(true);
                  setConfirmState(null);
                }}
              >
                {confirmState.confirmLabel ?? "Delete"}
              </button>
            </div>
          </div>
        </div>
      )}

      {toast && (
        <div className="snackbar" role="status" aria-live="polite">
          {toast}
        </div>
      )}
    </main>
  );
}
