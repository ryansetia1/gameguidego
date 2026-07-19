"use client";

import type { User } from "@supabase/supabase-js";
import { FormEvent, type MouseEvent, useCallback, useEffect, useRef, useState } from "react";

import { AuthPanel } from "./auth-panel";
import { ComposerExtras } from "./composer-extras";
import { GameAutocomplete } from "./game-autocomplete";
import {
  IconArrowLeft,
  IconArrowUpRight,
  IconDiamond,
  IconDotsVertical,
  IconGrid,
  IconIncognito,
  IconPencil,
  IconPlus,
  IconRefresh,
  IconStop,
  IconX,
} from "./icons";
import { FUN_ROLES, HERO_LINES } from "@/lib/hero-copy.js";
import { guideIngestHint, guideIngestHintFromResponse } from "@/lib/guide-hints.js";
import {
  guideUrlsFromChat,
  guideUrlsPayload,
  guideUrlsSummary,
  isGamefaqsBundleUrl,
} from "@/lib/guide-urls.js";
import { compressImage } from "@/lib/image.js";
import { GuideLinkField, type GuideBundleMeta } from "./guide-link-field";
import { HltbRow } from "./hltb-row";
import { PlatformSelect } from "./platform-select";
import { SteamLibrary, type SteamGame } from "./steam-library";
import { ProfileMenu } from "./profile-menu";
import { VoiceVisualizer } from "./voice-visualizer";
import {
  KINDS,
  KIND_LABELS,
  coerceHighlights,
  coerceSpoilers,
  type Highlight,
  type SpoilerReveal,
} from "@/lib/highlights.js";
import { parseBlocks } from "@/lib/markdown.js";
import { tgdbPlatformToLabel } from "@/lib/platforms.js";
import {
  GAME_SPOILER_HINT,
  SPOILER_TOGGLE_LABEL,
  effectiveSpoilerPrefs,
  loadGameSpoilerPrefs,
  loadGlobalSpoilerPrefs,
  saveGameSpoilerPrefs,
  saveGlobalSpoilerPrefs,
  spoilerMajorFromUserMetadata,
  type SpoilerPrefs,
} from "@/lib/spoiler-prefs.js";
import { displayNameFromMetadata } from "@/lib/profile.js";
import { getSupabase, type Chat } from "@/lib/supabase";
import {
  loadLocalGames,
  removeLocalGame,
  upsertLocalGame,
} from "@/lib/local-games.js";
import { steamAppIdFromCoverUrl, steamIdFromMetadata } from "@/lib/steam.js";
import { getSpeechRecognition } from "@/lib/voice.js";
import {
  clearSessionDraft,
  getChatIdFromUrl,
  loadSessionDraft,
  saveSessionDraft,
  setChatUrl,
} from "@/lib/chat-session.js";

async function fetchSteamStatus(token?: string) {
  const headers: HeadersInit = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch("/api/steam/me", {
    credentials: "include",
    headers,
  });
  if (!response.ok) return { steamId: null as string | null, connected: false };
  const payload: { steamId?: string | null; connected?: boolean } = await response.json();
  return {
    steamId: payload.steamId ?? null,
    connected: Boolean(payload.connected),
  };
}

type Source = {
  title: string;
  url: string;
};

type Message = {
  role: "user" | "assistant";
  content: string;
  sources?: Source[];
  highlights?: Highlight[];
  spoilers?: SpoilerReveal[];
  images?: string[];
};

const EXAMPLES_DISMISSED_KEY = "gg:examples-dismissed";
const MAX_MESSAGE_IMAGES = 10;

// Downscale + re-encode to JPEG in the browser so a phone photo (several MB)
// becomes a Storage-friendly ~200-400KB before upload. Falls back to the original.
const examples = [
  { game: "The Legend of Zelda: Link's Awakening", platform: "Game Boy", q: "How do I reach the first dungeon?" },
  { game: "Final Fantasy VII", platform: "PlayStation (PS1)", q: "How do I beat Emerald Weapon?" },
  { game: "Elden Ring", platform: "PC", q: "Best build for beginners" },
];

function hostname(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "web";
  }
}

function normGame(value: string) {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

// The Storage object path inside our `covers` bucket for a public URL, or null
// for anything that isn't ours to delete (e.g. TheGamesDB CDN covers).
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

function coerceMessages(value: unknown): Message[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): Message[] => {
    if (!item || typeof item !== "object") return [];
    const role = (item as { role?: unknown }).role;
    const content = (item as { content?: unknown }).content;
    if ((role !== "user" && role !== "assistant") || typeof content !== "string") {
      return [];
    }
    const rawSources = (item as { sources?: unknown }).sources;
    const sources = Array.isArray(rawSources) ? (rawSources as Source[]) : undefined;
    const highlights = coerceHighlights((item as { highlights?: unknown }).highlights);
    const spoilers = coerceSpoilers((item as { spoilers?: unknown }).spoilers);
    const rawImages = (item as { images?: unknown }).images;
    const images = Array.isArray(rawImages)
      ? rawImages.filter((url): url is string => typeof url === "string")
      : [];
    return [
      {
        role,
        content,
        sources,
        ...(highlights.length ? { highlights } : {}),
        ...(spoilers.length ? { spoilers } : {}),
        ...(images.length ? { images } : {}),
      },
    ];
  });
}

function renderInline(segments: { text: string; bold: boolean; italic: boolean }[]) {
  return segments.map((seg, i) => {
    if (seg.bold) return <strong key={i}>{seg.text}</strong>;
    if (seg.italic) return <em key={i}>{seg.text}</em>;
    return <span key={i}>{seg.text}</span>;
  });
}

// Render the model's light markdown (paragraphs, numbered/bulleted lists, bold)
// as real elements so **bold** and "1." aren't shown literally and text wraps.
function AnswerBody({ text }: { text: string }) {
  return (
    <div className="answer">
      {parseBlocks(text).map((block, i) => {
        if (block.type === "ol") {
          return (
            <ol key={i}>
              {block.items.map((item, j) => (
                <li key={j}>{renderInline(item)}</li>
              ))}
            </ol>
          );
        }
        if (block.type === "ul") {
          return (
            <ul key={i}>
              {block.items.map((item, j) => (
                <li key={j}>{renderInline(item)}</li>
              ))}
            </ul>
          );
        }
        if (block.type === "h") {
          return <h4 key={i}>{renderInline(block.segments)}</h4>;
        }
        return <p key={i}>{renderInline(block.segments)}</p>;
      })}
    </div>
  );
}

// Box art if we have a URL, otherwise a letter tile (matches the brand mark).
function CoverThumb({
  cover,
  name,
  className,
}: {
  cover: string;
  name: string;
  className?: string;
}) {
  const cls = `cover${className ? ` ${className}` : ""}`;
  if (cover) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img className={cls} src={cover} alt={`${name || "Game"} cover`} />;
  }
  return (
    <span className={`${cls} cover-placeholder`} aria-hidden="true">
      {(name.trim()[0] || "?").toUpperCase()}
    </span>
  );
}

// Cosmetic platform label: a Steam-sourced game (its cover is a Steam CDN URL)
// shows "Steam" instead of "PC" so users can tell it apart from Epic/GOG/etc.
// The stored `platform` stays "PC" — search (Tavily/Serper) still treats it as a
// PC game; this is display-only.
function displayPlatform(platform: string, coverUrl?: string | null): string {
  return steamAppIdFromCoverUrl(coverUrl ?? "") ? "Steam" : platform;
}

function RotatingHeadline() {
  // Pick a random line on mount only, so it changes per refresh/open but not
  // mid-view. Starts at index 0 (matches SSR) then swaps client-side, avoiding
  // a hydration mismatch.
  const [i, setI] = useState(0);
  useEffect(() => {
    setI(Math.floor(Math.random() * HERO_LINES.length));
  }, []);
  const [lead, payoff] = HERO_LINES[i];
  return (
    <h1>
      {lead} <em>{payoff}</em>
    </h1>
  );
}

function RotatingWord() {
  const [i, setI] = useState(0);
  // Tap/click to freeze on a word (e.g. to screenshot), tap again to resume.
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    if (paused) return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const id = setInterval(() => setI((n) => (n + 1) % FUN_ROLES.length), 2200);
    return () => clearInterval(id);
  }, [paused]);
  return (
    <button
      type="button"
      className="rotating-word"
      onClick={() => setPaused((p) => !p)}
      title={paused ? "Resume" : "Tap to pause"}
      aria-label={
        paused
          ? `Paused on "${FUN_ROLES[i]}". Activate to resume.`
          : "Rotating word — activate to pause."
      }
    >
      <span key={i} className="rotating-word-inner">
        {FUN_ROLES[i]}
      </span>
    </button>
  );
}

function SteamIcon() {
  return (
    <svg className="sidebar-steam-icon" viewBox="0 0 496 512" fill="currentColor" aria-hidden="true">
      <path d="M496 256c0 137-111.2 248-248.4 248-113.8 0-209.6-76.3-239-180.4l95.2 39.3c6.4 32.1 34.9 56.4 68.9 56.4 39.2 0 71.9-32.4 70.2-73.5l84.5-60.2c52.1 1.3 95.8-40.9 95.8-93.5 0-51.6-42-93.5-93.7-93.5s-93.7 42-93.7 93.5v1.2L176.6 279c-15.5-.9-30.7 3.4-43.5 12.1L0 236.1C10.2 108.4 117.1 8 247.6 8 384.8 8 496 119 496 256zM155.7 384.3l-30.5-12.6a52.79 52.79 0 0 0 27.2 25.8c26.9 11.2 57.8-1.6 69-28.5 5.4-13 5.5-27.3.1-40.3-5.4-13-15.5-23.2-28.5-28.6-12.9-5.4-26.7-5.2-38.9-.6l31.5 13c19.8 8.2 29.2 30.9 20.9 50.7-8.3 19.9-31 29.2-50.8 20.9v.2zm173.6-129.9c-34.4 0-62.4-28-62.4-62.3s28-62.3 62.4-62.3 62.4 28 62.4 62.3-27.9 62.3-62.4 62.3zm.1-15.6c25.9 0 46.9-21 46.9-46.8 0-25.9-21-46.8-46.9-46.8s-46.9 21-46.9 46.8c0 25.8 21 46.8 46.9 46.8z" />
    </svg>
  );
}

function groupHighlights(highlights: Highlight[]) {
  return KINDS.flatMap((kind) => {
    const items = highlights.filter((h) => h.kind === kind);
    return items.length ? [{ kind, items }] : [];
  });
}

function SpoilerToggle({
  prefs,
  onChange,
  compact = false,
}: {
  prefs: SpoilerPrefs;
  onChange: (value: boolean) => void;
  compact?: boolean;
}) {
  return (
    <label className={`spoiler-toggle${compact ? " spoiler-toggle-compact" : ""}`}>
      <input
        type="checkbox"
        checked={prefs.major === true}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span>{SPOILER_TOGGLE_LABEL}</span>
    </label>
  );
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
  const [pendingImages, setPendingImages] = useState<{ blob: Blob; preview: string }[]>([]);
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [indexingGuideCount, setIndexingGuideCount] = useState(0);
  const [guideBundleMeta, setGuideBundleMeta] = useState<Record<string, GuideBundleMeta>>({});

  const [user, setUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [chats, setChats] = useState<Chat[]>([]);
  const [chatsLoaded, setChatsLoaded] = useState(false);
  // Home quick-access: hide the setup form behind a "+ New game" reveal when the
  // user already has saved games (signed-in or anon local). Reset on newGame().
  const [newGameOpen, setNewGameOpen] = useState(false);
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  // Temporary chat: lives only in memory, never written to Supabase/localStorage/
  // sessionStorage, so a refresh or close wipes it. Follow-ups still work (they
  // read from `messages` state, not storage).
  const [temporary, setTemporary] = useState(false);
  const [authOpen, setAuthOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [steamLibraryOpen, setSteamLibraryOpen] = useState(false);
  const [steamId, setSteamId] = useState<string | null>(null);
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null);
  const [examplesDismissed, setExamplesDismissed] = useState(false);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [editingText, setEditingText] = useState("");
  const [globalSpoilerMajor, setGlobalSpoilerMajor] = useState(false);
  const [gameSpoilerMajor, setGameSpoilerMajor] = useState(false);
  const spoilerPrefs = effectiveSpoilerPrefs(globalSpoilerMajor, gameSpoilerMajor);
  const [voiceListening, setVoiceListening] = useState(false);
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
  const topRef = useRef<HTMLElement>(null);
  const jumpRef = useRef(false);
  const chatHistoryPushed = useRef(false);
  const sessionHydratedRef = useRef(false);
  const steamLinkHandledRef = useRef(false);
  const steamSigninHandledRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
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
  const editTextareaRef = useRef<HTMLTextAreaElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  // Path of a previously-uploaded cover that a new pick will replace, deleted once
  // the replacement is saved so the bucket doesn't keep the orphan.
  const replacedCoverRef = useRef<string | null>(null);

  // Grow the composer to fit its text (down to one line when empty), capped by
  // the CSS max-height which then scrolls. Runs on every input + after clearing.
  useEffect(() => {
    const el = composerRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [input]);

  function pushOverlayHistory() {
    if (typeof window === "undefined") return;
    window.history.pushState({ gggOverlay: true }, "");
  }

  function dismissOverlay() {
    if (typeof window === "undefined") return;
    window.history.back();
  }

  useEffect(() => {
    function onPopState() {
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
        return;
      }
      if (authOpen) {
        setAuthOpen(false);
        return;
      }
      // No overlay open: a back press from a game thread returns to the home page.
      if (messages.length > 0) {
        chatHistoryPushed.current = false;
        newGame();
      }
    }
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [authOpen, libraryOpen, sidebarOpen, steamLibraryOpen, messages.length]);

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

  const supabaseReady = Boolean(getSupabase());
  // Cover art (TheGamesDB display + device upload) is a signed-in-only feature:
  // keeps the signed-out flow simple and avoids any Storage use for anon users.
  const coverEnabled = Boolean(user);
  const [voiceSupported, setVoiceSupported] = useState(false);
  const steamConnected = Boolean(
    user && (steamId || steamIdFromMetadata(user.user_metadata)),
  );

  const refreshSteamStatus = useCallback(async (token?: string) => {
    const status = await fetchSteamStatus(token);
    setSteamId(status.steamId);
    return status;
  }, []);

  const linkSteamToAccount = useCallback(async (): Promise<
    "ok" | "is_login_account" | "failed"
  > => {
    const supabase = getSupabase();
    if (!supabase || !user) return "failed";
    if (steamIdFromMetadata(user.user_metadata)) {
      setSteamId(steamIdFromMetadata(user.user_metadata));
      return "ok";
    }

    const { data: sessionData } = await supabase.auth.getSession();
    const token = sessionData.session?.access_token;
    const refreshToken = sessionData.session?.refresh_token;
    if (!token || !refreshToken) return "failed";

    // The gg_steam cookie set by the OpenID callback holds the verified SteamID;
    // /api/steam/link reads it server-side. Do NOT pre-check /api/steam/me — when
    // authenticated it deliberately ignores the cookie and returns null (the
    // account isn't linked yet), which would abort the link before it starts.
    const linkResponse = await fetch("/api/steam/link", {
      method: "POST",
      credentials: "include",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ refresh_token: refreshToken }),
    });
    const linkPayload: { ok?: boolean; error?: string; steamId?: string } =
      await linkResponse.json();
    if (!linkResponse.ok || !linkPayload.ok) {
      // The caller offers "Use your Steam account" for this one, so stay quiet.
      if (linkPayload.error === "steam_is_login_account") return "is_login_account";
      if (linkPayload.error !== "no_steam_session") {
        setError("Could not save Steam to your account. Your library still works on this device.");
      }
      return "failed";
    }

    const { data } = await supabase.auth.refreshSession();
    if (data.session?.user) setUser(data.session.user);
    if (linkPayload.steamId) setSteamId(linkPayload.steamId);
    setToast("Steam connected ✓");
    return "ok";
  }, [user]);

  // "Sign in with Steam" return: the gg_steam cookie holds a verified SteamID;
  // the bridge route mints/reuses the matching Supabase account and hands back a
  // session for us to adopt. Library then loads from the account's steam_id.
  const loginWithSteam = useCallback(async () => {
    const supabase = getSupabase();
    if (!supabase) return;
    const res = await fetch("/api/steam/session", {
      method: "POST",
      credentials: "include",
    });
    const payload: {
      ok?: boolean;
      access_token?: string;
      refresh_token?: string;
      steamId?: string;
    } = await res.json().catch(() => ({}));
    if (!res.ok || !payload.ok || !payload.access_token || !payload.refresh_token) {
      setError("Steam sign-in isn't available right now. Try Google or email.");
      return;
    }
    await supabase.auth.setSession({
      access_token: payload.access_token,
      refresh_token: payload.refresh_token,
    });
    // Pull the latest metadata (the bridge just refreshed avatar_steam) so the
    // avatar is current on first paint, not one login behind.
    const { data } = await supabase.auth.refreshSession();
    if (data.session?.user) setUser(data.session.user);
    if (payload.steamId) setSteamId(payload.steamId);
    setToast("Signed in with Steam ✓");
  }, []);

  useEffect(() => {
    activeChatIdRef.current = activeChatId;
  }, [activeChatId]);

  useEffect(() => {
    userRef.current = user;
  }, [user]);

  useEffect(() => {
    // Opening a saved chat (or restoring a draft) jumps to the last user turn so
    // the latest question stays in view with the answer below. A live turn uses
    // smooth scroll on each message update instead.
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
    lastUserRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [messages, loading]);

  useEffect(() => {
    setExamplesDismissed(
      typeof window !== "undefined" &&
        window.localStorage.getItem(EXAMPLES_DISMISSED_KEY) === "1",
    );
  }, []);

  const loadChats = useCallback(async () => {
    const supabase = getSupabase();
    // Signed-out (or Supabase-less): recent games live in localStorage.
    if (!supabase || !userRef.current) {
      setChats(loadLocalGames());
      return;
    }
    const { data, error: loadError } = await supabase
      .from("chats")
      // select("*") tolerates the cover-metadata columns being absent before the
      // migration is applied (a named select would error on a missing column).
      .select("*")
      .order("updated_at", { ascending: false });
    if (!loadError && data) setChats(data as Chat[]);
  }, []);

  useEffect(() => {
    const supabase = getSupabase();
    if (!supabase) {
      setAuthReady(true);
      return;
    }
    let mounted = true;
    supabase.auth.getSession().then(({ data }) => {
      if (mounted) {
        setUser(data.session?.user ?? null);
        setAuthReady(true);
      }
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null);
    });
    return () => {
      mounted = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!authReady) return;
    setChatsLoaded(false);
    // Anon users read their recent games from localStorage; loadChats branches
    // on userRef, so this covers both signed-in and signed-out.
    void loadChats().finally(() => setChatsLoaded(true));
  }, [user, loadChats, authReady]);

  // After auth + chat list load, reopen the thread from ?chat= or sessionStorage.
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
      setMessages(coerceMessages(draft.messages));
      conversationGame.current = draft.game;
      setInput("");
      setError("");
      setEditingIndex(null);
      setEditingText("");
      // ?chat= restore is signed-in only; anon relies on this draft, so don't
      // push a local id into the URL.
      if (draft.activeChatId && user) setChatUrl(draft.activeChatId);
      sessionHydratedRef.current = true;
      return;
    }

    sessionHydratedRef.current = true;
  }, [authReady, chatsLoaded, user, chats]);

  // One-shot backfill: older Steam chats were saved before release-year existed.
  // Spot them by the Steam appId in their cover URL, fetch the year (keyless
  // appdetails endpoint), and fill the empty column. Best-effort, capped, runs
  // once per mount; self-heals so later loads find nothing to do.
  useEffect(() => {
    if (!chatsLoaded || !user || steamBackfillRef.current) return;
    const supabase = getSupabase();
    if (!supabase) return;
    const pending = chats
      .filter((chat) => !chat.release_year)
      .map((chat) => ({ chat, appId: steamAppIdFromCoverUrl(chat.cover_url ?? "") }))
      .filter((row): row is { chat: Chat; appId: number } => row.appId != null)
      .slice(0, 25); // cap to stay well under appdetails rate limits
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
          // best-effort — skip this one
        }
      }
      if (filled) void loadChats();
    })();
  }, [chatsLoaded, user, chats, loadChats]);

  // Keep the URL / session draft in sync so a refresh returns to this thread.
  useEffect(() => {
    if (!sessionHydratedRef.current) return;
    if (messages.length === 0) {
      clearSessionDraft();
      setChatUrl(null);
      return;
    }
    // Temporary chat: keep nothing so a refresh or close wipes it.
    if (temporary) {
      clearSessionDraft();
      setChatUrl(null);
      return;
    }
    // Signed-in saved chats restore via ?chat=; anon local games have an id too
    // but must fall through to the sessionStorage draft (no ?chat= for anon).
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
      // Anon: keep the local game id so a refresh resumes the same entry and
      // later turns update it rather than forking a new one.
      activeChatId,
      messages,
    });
  }, [messages, activeChatId, game, platform, preferredUrls, cover, releaseYear, user, temporary]);

  // Hydrate GameFAQs bundle page counts for saved chats / session restore.
  useEffect(() => {
    let cancelled = false;
    const missing = preferredUrls.filter(
      (url) => isGamefaqsBundleUrl(url) && !guideBundleMeta[url],
    );
    if (!missing.length) return;

    void Promise.all(
      missing.map(async (url) => {
        try {
          const response = await fetch(
            `/api/guide-bundle?url=${encodeURIComponent(url)}`,
          );
          const data: {
            bundle?: boolean;
            pageCount?: number;
            title?: string;
          } = await response.json();
          if (!response.ok || !data.bundle || !data.pageCount) return null;
          return {
            url,
            meta: {
              title: data.title ?? "GameFAQs guide",
              pageCount: data.pageCount,
            },
          };
        } catch {
          return null;
        }
      }),
    ).then((rows) => {
      if (cancelled) return;
      const found = rows.filter((row): row is { url: string; meta: GuideBundleMeta } =>
        Boolean(row),
      );
      if (!found.length) return;
      setGuideBundleMeta((prev) => {
        const next = { ...prev };
        for (const row of found) next[row.url] = row.meta;
        return next;
      });
    });

    return () => {
      cancelled = true;
    };
  }, [preferredUrls, guideBundleMeta]);

  const bundlePageTotal = preferredUrls.reduce(
    (sum, url) => sum + (guideBundleMeta[url]?.pageCount ?? 0),
    0,
  );

  useEffect(() => {
    void refreshSteamStatus();
  }, [refreshSteamStatus]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const steam = params.get("steam");
    if (!steam) return;

    const stripParam = () => {
      params.delete("steam");
      const rest = params.toString();
      window.history.replaceState(
        {},
        "",
        `${window.location.pathname}${rest ? `?${rest}` : ""}`,
      );
    };

    if (steam === "error") {
      stripParam();
      setError("Steam sign-in failed. Try again.");
      return;
    }
    if (steam === "signin") {
      // "Sign in with Steam" return: bridge the gg_steam cookie into a Supabase
      // session. Runs once, independent of the (still signed-out) user state.
      if (steamSigninHandledRef.current) return;
      steamSigninHandledRef.current = true;
      stripParam();
      void loginWithSteam();
      return;
    }
    if (steam === "linked") {
      // Linking needs the signed-in Supabase user, whose session loads async.
      // Wait for it before consuming the param, or we'd strip it and no-op.
      if (!user || steamLinkHandledRef.current) return;
      steamLinkHandledRef.current = true;
      stripParam();
      void (async () => {
        const status = await linkSteamToAccount();
        // This Steam already has its own account, so it can't also be attached
        // here. Offer to jump into that Steam account instead of dead-ending.
        if (status === "is_login_account") {
          const ok = await askConfirm(
            "This Steam already has its own account, so it can't also be added to this one. Sign in with your Steam account instead? You'll switch out of the account you're in now.",
            "Use your Steam account",
            false,
          );
          if (ok) await loginWithSteam();
        }
      })();
    }
  }, [user, linkSteamToAccount, loginWithSteam, askConfirm]);

  // On sign-in, only REFRESH status (surfaces an already-linked account's Steam).
  // Linking happens solely on the explicit `?steam=linked` return above, so a
  // leftover device cookie can never silently attach to whoever signs in next.
  useEffect(() => {
    if (!user) return;
    void (async () => {
      const supabase = getSupabase();
      const token = (await supabase?.auth.getSession())?.data.session?.access_token;
      await refreshSteamStatus(token);
    })();
  }, [refreshSteamStatus, user]);

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
      authOpen || confirmState !== null || editingGame || editingIndex !== null;
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

  useEffect(() => {
    if (editingIndex === null) return;
    editTextareaRef.current?.focus();
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
    setGuideBundleMeta({});
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
    setEditingText("");
    conversationGame.current = "";
    setSidebarOpen(false);
    setMenuOpenId(null);
    setTemporary(false);
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
      setEditingText("");
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
    requestAnimationFrame(() => {
      document.getElementById("game")?.focus();
    });
  }

  function openChat(chat: Chat) {
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
    setMessages(coerceMessages(chat.messages));
    conversationGame.current = chat.game;
    setInput("");
    setError("");
    setEditingIndex(null);
    setEditingText("");
    setSidebarOpen(false);
    setMenuOpenId(null);
    setTemporary(false);
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
          ...guideUrlsPayload(preferredUrls),
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
          ...guideUrlsPayload(preferredUrls),
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

  function connectSteam() {
    if (!user) {
      setError("Sign in first, then connect Steam.");
      setAuthOpen(true);
      pushOverlayHistory();
      return;
    }
    window.location.href = "/api/steam/login?intent=link";
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
    setGuideBundleMeta({});
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
    setEditingText("");
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
      if (target) URL.revokeObjectURL(target.preview);
      return prev.filter((_, i) => i !== index);
    });
  }

  function clearPendingImages() {
    setPendingImages((prev) => {
      for (const item of prev) URL.revokeObjectURL(item.preview);
      return [];
    });
  }

  async function uploadMessageImages(): Promise<string[]> {
    if (!pendingImages.length) return [];
    const supabase = getSupabase();
    if (!supabase || !user) return [];
    const urls: string[] = [];
    for (const { blob } of pendingImages) {
      try {
        const path = `${user.id}/msg/${crypto.randomUUID()}.jpg`;
        const { error: upErr } = await supabase.storage
          .from("covers")
          .upload(path, blob, { contentType: "image/jpeg", upsert: true });
        if (upErr) throw upErr;
        urls.push(supabase.storage.from("covers").getPublicUrl(path).data.publicUrl);
      } catch (caught) {
        console.error("Image upload failed:", caught);
      }
    }
    return urls;
  }

  async function signOut() {
    await getSupabase()?.auth.signOut();
    // Clear the device Steam session too — otherwise the leftover gg_steam
    // cookie auto-links to the next account signed in on this browser
    // (shared-device library leak).
    await fetch("/api/steam/pending", { method: "DELETE", credentials: "include" }).catch(
      () => {},
    );
    setSteamId(null);
    // Reset the open thread (it referenced a signed-in chat); loadChats then
    // repopulates from anon localStorage. Previously handled by the !user effect.
    newGame();
  }

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
    // Collect this chat's own Storage files (cover + message images) so deleting
    // the chat doesn't orphan them in the bucket.
    const urls = [
      chat.cover_url ?? "",
      ...coerceMessages(chat.messages).flatMap((message) => message.images ?? []),
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

  async function persistChat(nextMessages: Message[], targetChatId: string | null) {
    if (temporary) return null; // temporary chat: nothing gets written anywhere
    const supabase = getSupabase();
    // Anon: persist to localStorage (Chat-shaped, no Storage — cover is CDN/"").
    if (!supabase || !user) {
      const id = targetChatId ?? crypto.randomUUID();
      upsertLocalGame({
        id,
        game,
        platform,
        ...guideUrlsPayload(preferredUrls),
        cover_url: cover.startsWith("blob:") ? "" : cover,
        release_year: releaseYear,
        messages: nextMessages,
        updated_at: new Date().toISOString(),
      });
      if (!targetChatId) setActiveChatId(id);
      setChats(loadLocalGames());
      return id;
    }
    // Upload a pending device cover only now (message is being saved), so covers
    // never land in Storage for abandoned drafts.
    const coverUrl = await resolveCoverUrl();
    const payload = {
      game,
      platform,
      ...guideUrlsPayload(preferredUrls),
      cover_url: coverUrl,
      release_year: releaseYear,
      messages: nextMessages,
      updated_at: new Date().toISOString(),
    };
    try {
      if (targetChatId) {
        await supabase.from("chats").update(payload).eq("id", targetChatId);
        void loadChats();
        return targetChatId;
      }
      const { data } = await supabase
        .from("chats")
        .insert({ ...payload, user_id: user.id })
        .select("id")
        .single();
      const newId = data ? (data as { id: string }).id : null;
      if (newId) {
        setActiveChatId(newId);
        void loadChats();
      }
      return newId;
    } catch (caught) {
      console.error("Failed to save chat:", caught);
      return targetChatId;
    }
  }

  async function runTurn(
    question: string,
    priorMessages: Message[],
    targetChatId: string | null,
    images: string[] = [],
  ) {
    setError("");
    setLoading(true);
    setEditingIndex(null);
    setEditingText("");
    let succeeded = false;

    const history = priorMessages
      .slice(-10)
      .map(({ role, content }) => ({ role, content }));
    const userMessage: Message = {
      role: "user",
      content: question,
      ...(images.length ? { images } : {}),
    };
    const optimistic: Message[] = [...priorMessages, userMessage];
    setMessages(optimistic);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      let ingestHint: string | null = null;
      if (preferredUrls.length) {
        const bundlePages = preferredUrls.reduce(
          (sum, url) => sum + (guideBundleMeta[url]?.pageCount ?? 0),
          0,
        );
        setIndexingGuideCount(
          bundlePages > 1 ? bundlePages : preferredUrls.length,
        );
        try {
          const ingestResponse = await fetch("/api/guide-ingest", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            signal: controller.signal,
            body: JSON.stringify({ preferredUrls }),
          });
          if (ingestResponse.ok) {
            const ingestData: unknown = await ingestResponse.json();
            ingestHint = guideIngestHintFromResponse(ingestData);
            if (ingestHint) setToast(ingestHint);
          } else if (!controller.signal.aborted) {
            let message: string | null = null;
            try {
              const errData: unknown = await ingestResponse.json();
              if (
                errData &&
                typeof errData === "object" &&
                "error" in errData &&
                typeof errData.error === "string"
              ) {
                message = errData.error;
              }
            } catch {
              // ignore parse errors
            }
            ingestHint =
              message ??
              guideIngestHint({
                available: true,
                indexed: false,
                total: preferredUrls.length,
                indexedCount: 0,
              });
            if (ingestHint) setToast(ingestHint);
          }
        } catch (ingestError) {
          if (!(ingestError instanceof DOMException && ingestError.name === "AbortError")) {
            console.error("Guide ingest failed:", ingestError);
            ingestHint = guideIngestHint({
              available: true,
              indexed: false,
              total: preferredUrls.length,
              indexedCount: 0,
            });
            if (ingestHint) setToast(ingestHint);
          }
        } finally {
          setIndexingGuideCount(0);
        }
      }

      const response = await fetch("/api/solve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          game,
          platform,
          question,
          history,
          preferredUrls,
          images,
          spoilerPrefs,
          playerName: user ? displayNameFromMetadata(user.user_metadata) : "",
          userId: user?.id ?? null,
        }),
      });
      const data: unknown = await response.json();

      if (
        !response.ok ||
        !data ||
        typeof data !== "object" ||
        !("answer" in data) ||
        typeof data.answer !== "string"
      ) {
        const message =
          data &&
          typeof data === "object" &&
          "error" in data &&
          typeof data.error === "string"
            ? data.error
            : "Couldn't build a guide. Please try again.";
        throw new Error(message);
      }

      const sources =
        "sources" in data && Array.isArray(data.sources)
          ? (data.sources as Source[])
          : [];
      if (
        "guideHint" in data &&
        typeof data.guideHint === "string" &&
        data.guideHint &&
        data.guideHint !== ingestHint
      ) {
        setToast(data.guideHint);
      }
      const highlights = coerceHighlights(
        "highlights" in data ? data.highlights : undefined,
      );
      const spoilers = coerceSpoilers("spoilers" in data ? data.spoilers : undefined);
      const nextMessages: Message[] = [
        ...priorMessages,
        userMessage,
        {
          role: "assistant",
          content: data.answer as string,
          sources,
          ...(highlights.length ? { highlights } : {}),
          ...(spoilers.length && spoilerPrefs.major ? { spoilers } : {}),
        },
      ];
      setMessages(nextMessages);
      conversationGame.current = game;
      const savedId = await persistChat(nextMessages, targetChatId);
      if (savedId) activeChatIdRef.current = savedId;
      // Temporary chat never persists, so drop this turn's uploaded images from
      // Storage instead of leaving them orphaned.
      if (temporary && images.length) void deleteMessageImages([userMessage]);
      succeeded = true;
    } catch (caught) {
      setMessages(priorMessages);
      // A user-triggered Stop aborts the fetch — treat it as a silent cancel,
      // not an error.
      if (!(caught instanceof DOMException && caught.name === "AbortError")) {
        setError(
          caught instanceof Error ? caught.message : "An unknown error occurred.",
        );
      }
    } finally {
      abortRef.current = null;
      setLoading(false);
      // Answer's in: hand focus back to the composer so a follow-up can be typed
      // right away. rAF waits for the textarea to un-disable after loading clears.
      if (succeeded) {
        requestAnimationFrame(() => composerRef.current?.focus());
      }
    }
  }

  function stopGeneration() {
    abortRef.current?.abort();
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const question = input.trim();
    if (!game.trim() || question.length < 2 || loading) return;

    const switching =
      messages.length > 0 &&
      normGame(game) !== normGame(conversationGame.current);
    const priorMessages = switching ? [] : messages;
    const targetChatId = switching ? null : activeChatIdRef.current;
    if (switching) setActiveChatId(null);

    setInput("");
    setLoading(true); // cover the upload gap before runTurn takes over
    const images = await uploadMessageImages();
    clearPendingImages();
    await runTurn(question, priorMessages, targetChatId, images);
  }

  function startEdit(index: number) {
    if (loading) return;
    setEditingIndex(index);
    setEditingText(messages[index].content);
  }

  function cancelEdit() {
    setEditingIndex(null);
    setEditingText("");
  }

  // Editing/retrying discards the dropped turns' attached images. Confirm first
  // when there's actually an image to lose; plain text edits stay instant.
  async function confirmDropImages(dropped: Message[]) {
    const count = dropped.reduce((n, m) => n + (m.images?.length ?? 0), 0);
    if (count === 0) return true;
    return askConfirm(
      `This removes ${count} attached image${count > 1 ? "s" : ""}. Continue?`,
    );
  }

  async function saveEdit(index: number) {
    const text = editingText.trim();
    if (text.length < 2 || loading) return;
    const dropped = messages.slice(index);
    if (!(await confirmDropImages(dropped))) return;
    await deleteMessageImages(dropped);
    await runTurn(text, messages.slice(0, index), activeChatIdRef.current);
  }

  async function retry(index: number) {
    if (loading || index < 1 || messages[index - 1].role !== "user") return;
    const question = messages[index - 1].content;
    const dropped = messages.slice(index - 1);
    if (!(await confirmDropImages(dropped))) return;
    await deleteMessageImages(dropped);
    await runTurn(question, messages.slice(0, index - 1), activeChatIdRef.current);
  }

  const started = messages.length > 0;
  const hasGame = Boolean(game.trim());
  const composerLocked = loading || !hasGame;
  // Home layout states:
  // - Empty account: marketing hero + setup form (+ examples).
  // - Has saved games (quick home): hero + carousel + CTAs; "+ New game" collapses
  //   the hero and reveals the setup form below the carousel (push-up motion).
  const homeMode = !started && !editingGame;
  const hasRecent = homeMode && chats.length > 0;
  const showCarousel = hasRecent && (newGameOpen || !hasGame);
  const quickIdle = showCarousel && !newGameOpen;
  const showHero = homeMode;
  const showSetupForm = homeMode && !quickIdle;
  const QUICK_LIMIT = 4;
  const recentGames = chats.slice(0, QUICK_LIMIT);
  const moreGamesCount = chats.length - recentGames.length;
  const lastUserIndex = messages.map((m) => m.role).lastIndexOf("user");

  return (
    <main>
      <nav className="nav" aria-label="Brand">
        <div className="nav-left">
          {(user || chats.length > 0) && (
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
          <a className="brand" href="#" aria-label="Game Guide Go, home">
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
            onSignIn={() => {
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

      {/* Anon users now have local recent games too, so the sidebar list + saved
          library must render for them (the "+N more" tile opens the library).
          Steam/profile controls inside stay individually gated on `user`. */}
      {(user || chats.length > 0) && (
        <>
          <div
            className={`sidebar-backdrop${sidebarOpen ? " open" : ""}`}
            onClick={() => {
              setSidebarOpen(false);
              setMenuOpenId(null);
              dismissOverlay();
            }}
            aria-hidden="true"
          />
          <aside
            className={`sidebar${sidebarOpen ? " open" : ""}`}
            aria-label="Your games"
            aria-hidden={!sidebarOpen}
          >
            <div className="sidebar-head">
              <span>Your games</span>
              <button
                type="button"
                className="sidebar-close"
                aria-label="Close sidebar"
                onClick={() => {
                  setSidebarOpen(false);
                  dismissOverlay();
                }}
              >
                <IconX />
              </button>
            </div>
            <div className="sidebar-actions">
              <button
                type="button"
                className="sidebar-library-btn icon-inline"
                onClick={openSavedLibrary}
              >
                <IconGrid /> Saved library
              </button>
              {user && !steamConnected && (
                <button type="button" className="sidebar-steam-btn" onClick={connectSteam}>
                  <SteamIcon /> Connect Steam
                </button>
              )}
              {steamConnected && (
                <button
                  type="button"
                  className="sidebar-steam-btn"
                  onClick={openSteamLibrary}
                >
                  <SteamIcon /> Steam library
                </button>
              )}
            </div>
            <div className="sidebar-scroll">
            {chats.length === 0 ? (
              <p className="sidebar-empty">No saved games yet.</p>
            ) : (
              <ul className="sidebar-list">
                {chats.map((chat) => (
                  <li
                    key={chat.id}
                    className={`sidebar-row${chat.id === activeChatId ? " active" : ""}`}
                  >
                    <button
                      type="button"
                      className="sidebar-open"
                      onClick={() => openChat(chat)}
                    >
                      <CoverThumb
                        cover={chat.cover_url ?? ""}
                        name={chat.game}
                        className="cover-sm"
                      />
                      <span className="sidebar-meta">
                        <strong>{chat.game || "Untitled game"}</strong>
                        {(chat.platform || chat.release_year) && (
                          <small>
                            {[displayPlatform(chat.platform, chat.cover_url), chat.release_year]
                              .filter(Boolean)
                              .join(" · ")}
                          </small>
                        )}
                      </span>
                    </button>
                    <div className="row-menu">
                      <button
                        type="button"
                        className="kebab"
                        aria-label={`Options for ${chat.game || "Untitled game"}`}
                        aria-expanded={menuOpenId === chat.id}
                        onClick={(event) => toggleRowMenu(chat.id, event)}
                      >
                        <IconDotsVertical />
                      </button>
                      {menuOpenId === chat.id && (
                        <div className="row-menu-pop" role="menu">
                          <button
                            type="button"
                            className="row-menu-item"
                            onClick={(event) => editGame(chat, event)}
                          >
                            Edit
                          </button>
                          <button
                            type="button"
                            className="row-menu-item row-menu-delete"
                            onClick={(event) => void deleteChat(chat, event)}
                          >
                            Delete
                          </button>
                        </div>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
            <div className="sidebar-footer">
              <button type="button" className="sidebar-new icon-inline" onClick={startNewGame}>
                <IconPlus /> New game
              </button>
            </div>
            </div>
          </aside>

          {libraryOpen && (
            <>
              <button
                type="button"
                className="library-backdrop open"
                aria-label="Close library"
                onClick={dismissOverlay}
              />
              <div className="library open" role="dialog" aria-label="Saved library">
                <div className="library-panel">
                  <div className="library-head">
                    <span>Saved library</span>
                    <button
                      type="button"
                      className="sidebar-close"
                      aria-label="Close library"
                      onClick={dismissOverlay}
                    >
                      <IconX />
                    </button>
                  </div>
                  {chats.length === 0 ? (
                    <p className="library-empty">No saved games yet.</p>
                  ) : (
                    (() => {
                      const term = librarySearch.trim().toLowerCase();
                      const shown = term
                        ? chats.filter((chat) =>
                            (chat.game || "").toLowerCase().includes(term),
                          )
                        : chats;
                      return (
                        <>
                          <div className="library-search-wrap">
                            <input
                              id="saved-library-search"
                              type="search"
                              className="library-search"
                              placeholder="Search saved games…"
                              value={librarySearch}
                              onChange={(event) => setLibrarySearch(event.target.value)}
                              autoComplete="off"
                              aria-label="Search saved games"
                            />
                          </div>
                          {shown.length === 0 ? (
                            <p className="library-empty">
                              No games match “{librarySearch.trim()}”.
                            </p>
                          ) : (
                            <div className="library-grid">
                              {shown.map((chat) => (
                                <div key={chat.id} className="library-card">
                                  <button
                                    type="button"
                                    className="library-open"
                                    onClick={() => openFromLibrary(chat)}
                                  >
                                    <CoverThumb
                                      cover={chat.cover_url ?? ""}
                                      name={chat.game}
                                      className="cover-tile"
                                    />
                                    <strong>{chat.game || "Untitled game"}</strong>
                                    {(chat.platform || chat.release_year) && (
                                      <small>
                                        {[
                                          displayPlatform(chat.platform, chat.cover_url),
                                          chat.release_year,
                                        ]
                                          .filter(Boolean)
                                          .join(" · ")}
                                      </small>
                                    )}
                                  </button>
                                  <div className="row-menu library-card-menu">
                                    <button
                                      type="button"
                                      className="kebab"
                                      aria-label={`Options for ${chat.game || "Untitled game"}`}
                                      aria-expanded={menuOpenId === `lib-${chat.id}`}
                                      onClick={(event) => toggleRowMenu(`lib-${chat.id}`, event)}
                                    >
                                      <IconDotsVertical />
                                    </button>
                                    {menuOpenId === `lib-${chat.id}` && (
                                      <div className="row-menu-pop" role="menu">
                                        <button
                                          type="button"
                                          className="row-menu-item"
                                          onClick={() => editFromLibrary(chat)}
                                        >
                                          Edit
                                        </button>
                                        <button
                                          type="button"
                                          className="row-menu-item row-menu-delete"
                                          onClick={(event) => void deleteChat(chat, event)}
                                        >
                                          Delete
                                        </button>
                                      </div>
                                    )}
                                  </div>
                                </div>
                              ))}
                            </div>
                          )}
                        </>
                      );
                    })()
                  )}
                </div>
              </div>
            </>
          )}

          <SteamLibrary
            open={steamLibraryOpen}
            onClose={dismissOverlay}
            onPick={startFromSteamGame}
            cacheKey={steamId ?? user?.id ?? ""}
          />
        </>
      )}

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
            className="sticky-back"
            onClick={(event) => {
              event.stopPropagation();
              goHome();
            }}
            aria-label="Back to home"
          >
            <IconArrowLeft />
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

      {showHero && (
        <div
          className={`hero-shell${newGameOpen && hasRecent ? " hero-shell--exit" : ""}`}
          aria-hidden={newGameOpen && hasRecent}
        >
          <section className={`hero${hasRecent ? " hero--quick" : ""}`}>
            <p className="eyebrow">
              Companion for <RotatingWord />
            </p>
            <RotatingHeadline />
            <p className="intro">
              Say the game and where you&apos;re stuck. We turn web guides into steps
              you can act on.
            </p>
          </section>
        </div>
      )}

      {showCarousel && (
        <section
          className={`quick-home${newGameOpen ? " quick-home--form-open" : ""}`}
          aria-label="Recent games"
          ref={topRef}
        >
          <div className="quick-head">
            <h2>Jump back in</h2>
          </div>
          <div className="quick-rail">
            {recentGames.map((chat) => (
              <button
                key={chat.id}
                type="button"
                className="quick-card"
                onClick={() => openChat(chat)}
              >
                <CoverThumb
                  cover={chat.cover_url ?? ""}
                  name={chat.game}
                  className="cover-lg"
                />
                <span className="quick-card-meta">
                  <strong>{chat.game || "Untitled game"}</strong>
                  {(chat.platform || chat.release_year) && (
                    <small>
                      {[displayPlatform(chat.platform, chat.cover_url), chat.release_year]
                              .filter(Boolean)
                              .join(" · ")}
                    </small>
                  )}
                </span>
              </button>
            ))}
            {moreGamesCount > 0 && (
              <button
                type="button"
                className="quick-card quick-more"
                onClick={openSavedLibrary}
                aria-label={`See ${moreGamesCount} more saved games`}
              >
                <span className="quick-more-count">+{moreGamesCount}</span>
                <span className="quick-card-meta">
                  <strong>more</strong>
                  <small>Open library</small>
                </span>
              </button>
            )}
          </div>
          {/* Button reveals the setup form below (it renders next, since
              showSetupForm is now true); hidden once the form is open. */}
          {!newGameOpen && (
            <>
              <button type="button" className="quick-new icon-inline" onClick={startNewGame}>
                <IconPlus /> New game
              </button>
              {/* Library shortcuts. Steam shares the row only when connected;
                  otherwise Saved library fills the width. */}
              <div className="quick-libs">
                <button
                  type="button"
                  className="quick-lib-btn icon-inline"
                  onClick={openSavedLibrary}
                >
                  <IconGrid /> Saved library
                </button>
                {steamConnected && (
                  <button
                    type="button"
                    className="quick-lib-btn icon-inline"
                    onClick={openSteamLibrary}
                  >
                    <SteamIcon /> Steam library
                  </button>
                )}
              </div>
            </>
          )}
        </section>
      )}

      {started && !editingGame ? (
        <section className="game-card" aria-label="Game" ref={topRef}>
          {activeChatId && !temporary && (
            <button
              type="button"
              className="game-card-incognito"
              title="Start a temporary chat"
              aria-label="Start a temporary chat"
              disabled={loading}
              onClick={() => void toggleTemporary()}
            >
              <IconIncognito size={18} />
            </button>
          )}
          <div className="row-menu game-card-menu">
            <button
              type="button"
              className="kebab"
              aria-label="Game options"
              aria-expanded={menuOpenId === "game-card"}
              onClick={(event) => toggleRowMenu("game-card", event)}
              disabled={loading}
            >
              <IconDotsVertical />
            </button>
            {menuOpenId === "game-card" && (
              <div className="row-menu-pop" role="menu">
                <button
                  type="button"
                  className="row-menu-item"
                  onClick={() => {
                    setMenuOpenId(null);
                    setEditingGame(true);
                    scrollToTop();
                  }}
                >
                  Edit
                </button>
                <button
                  type="button"
                  className="row-menu-item row-menu-delete"
                  onClick={() => void deleteActiveChat()}
                >
                  Delete
                </button>
              </div>
            )}
          </div>
          {coverEnabled && <CoverThumb cover={cover} name={game} className="cover-lg" />}
          <div className={`game-card-meta${activeChatId && !temporary ? " has-quick" : ""}`}>
            <h2>{game || "Untitled game"}</h2>
            {(platform || releaseYear) && (
              <p>{[displayPlatform(platform, cover), releaseYear].filter(Boolean).join(" · ")}</p>
            )}
            <HltbRow title={game} appId={steamAppIdFromCoverUrl(cover)?.toString()} />
            {preferredUrls.length > 0 && (
              <div className="game-card-guides">
                {preferredUrls.map((url) => {
                  const meta = guideBundleMeta[url];
                  const bundle = isGamefaqsBundleUrl(url);
                  const label = bundle
                    ? meta
                      ? `${meta.title} (${meta.pageCount} pages)`
                      : "GameFAQs bundle"
                    : guideUrlsSummary([url]);
                  return (
                    <a
                      key={url}
                      className="game-card-link"
                      href={url}
                      target="_blank"
                      rel="noreferrer"
                    >
                      <span className="icon-inline">
                        {label} <IconArrowUpRight />
                      </span>
                    </a>
                  );
                })}
              </div>
            )}
            <div className="spoiler-panel">
              <SpoilerToggle
                prefs={{ major: gameSpoilerMajor }}
                onChange={updateGameSpoiler}
                compact
              />
            </div>
          </div>
        </section>
      ) : showSetupForm ? (
        // Mounting fresh when "+ New game" is tapped replays .setup's `rise`
        // animation, so revealing the form (below the carousel) is animated.
        <section
          className={`setup${newGameOpen && hasRecent ? " setup--from-quick" : ""}`}
          aria-label="Game context"
          ref={topRef}
        >
          <div className="setup-main">
          {/* Cover column only mounts once a cover exists (upload or autocomplete);
              its reveal animation gives the "fill in" effect. No cover = no noisy
              placeholder tile — the "+ Add cover" text button below stands in. */}
          {coverEnabled && cover && (
            <div className="field field-cover">
              <div className="cover-edit">
                <div className="cover-drop has-cover">
                  <CoverThumb cover={cover} name={game} className="cover-setup" />
                  <label className="cover-upload">
                    <span className="cover-upload-label">Replace</span>
                    <input
                      type="file"
                      accept="image/*"
                      hidden
                      disabled={uploadingCover || loading}
                      onChange={(event) => {
                        const file = event.target.files?.[0];
                        event.target.value = "";
                        if (file) selectCover(file);
                      }}
                    />
                  </label>
                  <button
                    type="button"
                    className="cover-clear"
                    aria-label="Remove cover"
                    onClick={() => void clearCover()}
                    disabled={uploadingCover || loading}
                  >
                    <IconX />
                  </button>
                </div>
                {pendingCover && <span className="cover-pending">Uploads when you send</span>}
              </div>
            </div>
          )}
          <div className="setup-fields">
            <div className="field field-game">
              <div className="field-head">
                <label htmlFor="game">Game name</label>
                {coverEnabled && !cover && (
                  <label className="cover-add-btn icon-inline">
                    <IconPlus /> Add cover
                    <input
                      type="file"
                      accept="image/*"
                      hidden
                      disabled={uploadingCover || loading}
                      onChange={(event) => {
                        const file = event.target.files?.[0];
                        event.target.value = "";
                        if (file) selectCover(file);
                      }}
                    />
                  </label>
                )}
              </div>
              <GameAutocomplete
                value={game}
                onChange={handleGameChange}
                onPick={pickGame}
                showCover={coverEnabled}
                disabled={loading}
              />
            </div>
            <div className="field field-platform">
              <span className="field-label" id="platform-label">
                Platform
              </span>
              <PlatformSelect value={platform} onChange={setPlatform} />
            </div>
          </div>
          </div>
          {/* Two triggers stay fixed side-by-side; the open section renders in the
              shared panel below. Only one open at a time, so toggling swaps the
              panel without shifting the triggers. */}
          <div className="opt-group">
            <div className="opt-tabs">
              <button
                type="button"
                className={`opt-tab${optPanel === "guide" ? " open" : ""}`}
                aria-expanded={optPanel === "guide"}
                aria-controls="opt-panel-guide"
                onClick={() => setOptPanel((cur) => (cur === "guide" ? null : "guide"))}
              >
                <span className="opt-summary-label">Preferred guides (optional)</span>
                {preferredUrls.length > 0 && (
                  <span className="opt-summary-value">{guideUrlsSummary(preferredUrls)}</span>
                )}
              </button>
              <button
                type="button"
                className={`opt-tab${optPanel === "spoiler" ? " open" : ""}`}
                aria-expanded={optPanel === "spoiler"}
                aria-controls="opt-panel-spoiler"
                onClick={() => setOptPanel((cur) => (cur === "spoiler" ? null : "spoiler"))}
              >
                <span className="opt-summary-label">Spoilers</span>
                <span className={`opt-summary-value${gameSpoilerMajor ? " is-on" : ""}`}>
                  {gameSpoilerMajor ? "On for this game" : "Off"}
                </span>
              </button>
            </div>
            {optPanel === "guide" && (
              <div className="opt-panel" id="opt-panel-guide">
                <GuideLinkField
                  value={preferredUrls}
                  onChange={setPreferredUrls}
                  bundleMeta={guideBundleMeta}
                  onBundleMetaChange={setGuideBundleMeta}
                  game={game}
                  platform={platform}
                  disabled={loading}
                />
              </div>
            )}
            {optPanel === "spoiler" && (
              <div className="opt-panel" id="opt-panel-spoiler">
                <p className="field-hint">{GAME_SPOILER_HINT}</p>
                <SpoilerToggle
                  prefs={{ major: gameSpoilerMajor }}
                  onChange={updateGameSpoiler}
                />
              </div>
            )}
          </div>
          {editingGame && (
            <div className="field field-wide setup-done">
              <button type="button" className="nav-button" onClick={() => void saveGameMeta()}>
                Done
              </button>
            </div>
          )}
        </section>
      ) : null}

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

      {started && (
        <section className="feed" aria-live="polite">
          {messages.map((message, index) =>
            message.role === "user" ? (
              <div
                className={`turn user${editingIndex === index ? " editing" : ""}`}
                key={index}
                ref={index === lastUserIndex ? lastUserRef : undefined}
              >
                {editingIndex === index ? (
                  <div className="edit-box">
                    <textarea
                      ref={editTextareaRef}
                      className="edit-textarea"
                      value={editingText}
                      onChange={(event) => setEditingText(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" && !event.shiftKey) {
                          event.preventDefault();
                          if (!loading && editingText.trim().length >= 2) {
                            void saveEdit(index);
                          }
                        }
                      }}
                      rows={5}
                      maxLength={300}
                      disabled={loading}
                    />
                    <div className="edit-actions">
                      <button
                        type="button"
                        className="turn-action"
                        onClick={() => void saveEdit(index)}
                        disabled={loading || editingText.trim().length < 2}
                      >
                        Send
                      </button>
                      <button
                        type="button"
                        className="turn-action turn-action-muted"
                        onClick={cancelEdit}
                        disabled={loading}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    {message.images && message.images.length > 0 && (
                      <div className="msg-images">
                        {message.images.map((url, i) => (
                          // eslint-disable-next-line @next/next/no-img-element
                          <a key={i} href={url} target="_blank" rel="noreferrer">
                            <img className="msg-image" src={url} alt="Attached" loading="lazy" />
                          </a>
                        ))}
                      </div>
                    )}
                    <p>{message.content}</p>
                    <button
                      type="button"
                      className="turn-action turn-action-icon"
                      aria-label="Edit message"
                      onClick={() => startEdit(index)}
                      disabled={loading}
                    >
                      <IconPencil />
                    </button>
                  </>
                )}
              </div>
            ) : (
              <article className="turn guide" key={index}>
                <div className="guide-head">
                  <div className="guide-tag icon-inline">
                    <IconDiamond /> ANSWER
                  </div>
                  <button
                    type="button"
                    className="turn-action turn-action-icon"
                    aria-label="Regenerate answer"
                    onClick={() => void retry(index)}
                    disabled={loading}
                  >
                    <IconRefresh />
                  </button>
                </div>
                <AnswerBody text={message.content} />
                {message.spoilers && spoilerPrefs.major && message.spoilers.length > 0 && (
                  <div className="spoiler-reveals">
                    {message.spoilers.map((item, i) => (
                      <details key={`spoiler-${i}`} className="spoiler-reveal">
                        <summary>
                          <span className="spoiler-reveal-tag">Major spoiler</span>
                          {item.title || "Tap to reveal"}
                        </summary>
                        <AnswerBody text={item.detail} />
                      </details>
                    ))}
                  </div>
                )}
                {message.highlights && message.highlights.length > 0 && (
                  <div className="highlights">
                    {groupHighlights(message.highlights).map(({ kind, items }) => (
                      <section key={kind} className="highlight-group">
                        <h3 className="highlight-label">{KIND_LABELS[kind]}</h3>
                        <ul className="highlight-list">
                          {items.map((item, i) =>
                            item.detail ? (
                              <li key={`${kind}-${i}`}>
                                <details className={`highlight highlight-${kind}`}>
                                  <summary>{item.title}</summary>
                                  <p>{item.detail}</p>
                                </details>
                              </li>
                            ) : (
                              <li key={`${kind}-${i}`}>
                                <div className={`highlight highlight-${kind} highlight-note`}>
                                  {item.title}
                                </div>
                              </li>
                            ),
                          )}
                        </ul>
                      </section>
                    ))}
                  </div>
                )}
                {message.sources && message.sources.length > 0 && (
                  <details className="sources">
                    <summary>Sources ({message.sources.length})</summary>
                    <ol>
                      {message.sources.map((source, i) => (
                        <li key={source.url}>
                          <a href={source.url} target="_blank" rel="noreferrer">
                            <span className="source-number">
                              {String(i + 1).padStart(2, "0")}
                            </span>
                            <span>
                              <strong>{source.title}</strong>
                              <small>{hostname(source.url)}</small>
                            </span>
                            <span className="source-arrow" aria-hidden="true">
                              <IconArrowUpRight />
                            </span>
                          </a>
                        </li>
                      ))}
                    </ol>
                  </details>
                )}
              </article>
            ),
          )}

          {loading && (
            <div className="turn guide loading-card">
              <span className="scan-line" aria-hidden="true" />
              <p>
                {indexingGuideCount
                  ? bundlePageTotal > 1
                    ? `Indexing GameFAQs bundle (${bundlePageTotal} pages)...`
                    : indexingGuideCount > 1
                      ? `Indexing ${indexingGuideCount} guides...`
                      : "Indexing your guide..."
                  : "Searching walkthroughs and player forums..."}
              </p>
            </div>
          )}

          {error && (
            <div className="error-card" role="alert">
              <span aria-hidden="true">!</span>
              <p>{error}</p>
            </div>
          )}
          <div ref={feedRef} />
        </section>
      )}

      {/* Composer is useless in the idle carousel state (no game field visible);
          it returns once "+ New game" reveals the setup form. */}
      {!quickIdle && (
      <form
        className={`composer${started ? " docked" : ""}${temporary ? " temporary" : ""}`}
        onSubmit={handleSubmit}
      >
        {coverEnabled && pendingImages.length > 0 && (
          <div className="composer-attachments">
            {pendingImages.map((img, i) => (
              <div key={i} className="attachment-thumb">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={img.preview} alt="Attachment preview" />
                <button
                  type="button"
                  aria-label="Remove image"
                  onClick={() => removePendingImage(i)}
                  disabled={loading}
                >
                  <IconX size={16} />
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="composer-inner">
          <div className="composer-field">
            <textarea
              ref={composerRef}
              id="query"
              name="query"
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                }
              }}
              placeholder={
                voiceListening
                  ? ""
                  : !hasGame
                    ? "Enter a game name first"
                    : started
                      ? "Ask a follow-up..."
                      : "Where are you stuck?"
              }
              rows={1}
              maxLength={300}
              required
              disabled={composerLocked}
            />
            <VoiceVisualizer active={voiceListening} />
          </div>
          {temporary && (
            <button
              type="button"
              className="composer-temp-flag"
              title="Temporary chat on. Tap to turn off."
              aria-label="Temporary chat on. Tap to turn off."
              disabled={loading}
              onClick={() => void toggleTemporary()}
            >
              <IconIncognito />
            </button>
          )}
          <ComposerExtras
            user={user}
            disabled={composerLocked}
            attachDisabled={pendingImages.length >= MAX_MESSAGE_IMAGES}
            canAttach={coverEnabled}
            voiceSupported={voiceSupported}
            temporary={temporary}
            onToggleTemporary={() => void toggleTemporary()}
            onListeningChange={setVoiceListening}
            onTranscript={(text) =>
              setInput((prev) => (prev.trim() ? `${prev.trim()} ${text}` : text))
            }
            onSelectImages={(files) => void selectMessageImages(files)}
          />
          {loading ? (
            <button
              className="submit submit-stop"
              type="button"
              onClick={stopGeneration}
              aria-label="Stop generating"
            >
              <IconStop />
            </button>
          ) : (
            <button
              className="submit"
              type="submit"
              disabled={composerLocked || input.trim().length < 2}
              aria-label="Send question"
            >
              <IconArrowUpRight />
            </button>
          )}
        </div>
      </form>
      )}

      {!quickIdle && (
        <p className="disclaimer">
          Guides are summarized by AI. Check the sources for version-specific details.
        </p>
      )}

      {authOpen && <AuthPanel onClose={dismissOverlay} />}

      {confirmState && (
        <div
          className="confirm-overlay"
          role="presentation"
          onClick={(event) => {
            if (event.target === event.currentTarget) {
              confirmState.resolve(false);
              setConfirmState(null);
            }
          }}
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
