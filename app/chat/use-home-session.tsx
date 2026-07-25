"use client";

import type { User } from "@supabase/supabase-js";
import { useCallback, useEffect, useRef, useState } from "react";
import { getSupabase } from "@/lib/supabase";
import { steamIdFromMetadata } from "@/lib/steam.js";

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

export type UseHomeSessionOptions = {
  authOpen: boolean;
  setError: (message: string) => void;
  setToast: (message: string) => void;
  setAuthOpen: (open: boolean) => void;
  onSignedOut: () => void;
  askConfirm: (message: string, confirmLabel?: string, danger?: boolean) => Promise<boolean>;
  onSteamLinkNeedsSignIn: () => void;
};

export function useHomeSession({
  authOpen,
  setError,
  setToast,
  setAuthOpen,
  onSignedOut,
  askConfirm,
  onSteamLinkNeedsSignIn,
}: UseHomeSessionOptions) {
  const [user, setUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [steamId, setSteamId] = useState<string | null>(null);

  const steamLinkHandledRef = useRef(false);
  const steamSigninHandledRef = useRef(false);

  const supabaseReady = Boolean(getSupabase());
  const steamConnected = Boolean(user && (steamId || steamIdFromMetadata(user.user_metadata)));

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
      if (linkPayload.error === "steam_is_login_account") return "is_login_account";
      if (linkPayload.error !== "no_steam_session") {
        setError("Could not save Steam to your account. Your library still works on this device.");
      }
      return "failed";
    }

    const { data } = await supabase.auth.refreshSession();
    if (data.session?.user) setUser(data.session.user);
    if (linkPayload.steamId) setSteamId(linkPayload.steamId);
    setToast("Steam connected");
    return "ok";
  }, [user, setError, setToast]);

  const loginWithSteam = useCallback(async (): Promise<boolean> => {
    const supabase = getSupabase();
    if (!supabase) return false;
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
      return false;
    }
    await supabase.auth.setSession({
      access_token: payload.access_token,
      refresh_token: payload.refresh_token,
    });
    const { data } = await supabase.auth.refreshSession();
    if (data.session?.user) setUser(data.session.user);
    if (payload.steamId) setSteamId(payload.steamId);
    setToast("Signed in with Steam ✓");
    return true;
  }, [setError, setToast]);

  const handleSteamReturn = useCallback(
    (result: "signin" | "linked" | "error") => {
      if (result === "error") {
        setError("Steam sign-in failed. Try again.");
        return;
      }
      if (result === "signin") {
        if (steamSigninHandledRef.current) return;
        steamSigninHandledRef.current = true;
        void loginWithSteam().then((ok) => {
          if (ok && authOpen) window.history.back();
        });
        return;
      }
      if (!user || steamLinkHandledRef.current) return;
      steamLinkHandledRef.current = true;
      void (async () => {
        const status = await linkSteamToAccount();
        if (status === "is_login_account") {
          const ok = await askConfirm(
            "This Steam already has its own account, so it can't also be added to this one. Sign in with your Steam account instead? You'll switch out of the account you're in now.",
            "Use your Steam account",
            false,
          );
          if (ok) await loginWithSteam();
        }
      })();
    },
    [user, authOpen, linkSteamToAccount, loginWithSteam, askConfirm, setError],
  );

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
    void refreshSteamStatus();
  }, [refreshSteamStatus]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    function onMessage(event: MessageEvent) {
      if (event.origin !== window.location.origin) return;
      const data = event.data as { gg?: string; intent?: string; error?: boolean };
      if (!data || data.gg !== "steam") return;
      handleSteamReturn(
        data.error ? "error" : data.intent === "signin" ? "signin" : "linked",
      );
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [handleSteamReturn]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const steam = params.get("steam");
    if (!steam) return;
    if (steam === "linked" && !user) return;

    params.delete("steam");
    const rest = params.toString();
    window.history.replaceState(
      {},
      "",
      `${window.location.pathname}${rest ? `?${rest}` : ""}`,
    );

    if (steam === "error") handleSteamReturn("error");
    else if (steam === "signin") handleSteamReturn("signin");
    else if (steam === "linked") handleSteamReturn("linked");
  }, [user, handleSteamReturn]);

  useEffect(() => {
    if (!user) return;
    void (async () => {
      const supabase = getSupabase();
      const token = (await supabase?.auth.getSession())?.data.session?.access_token;
      await refreshSteamStatus(token);
    })();
  }, [refreshSteamStatus, user]);

  const connectSteam = useCallback(() => {
    if (!user) {
      setError("Sign in first, then connect Steam.");
      setAuthOpen(true);
      onSteamLinkNeedsSignIn();
      return;
    }
    const url = "/api/steam/login?intent=link";
    const w = window.open(`${url}&popup=1`, "gg_steam_auth", "width=520,height=700");
    if (!w) window.location.href = url;
  }, [user, setError, setAuthOpen, onSteamLinkNeedsSignIn]);

  const signOut = useCallback(async () => {
    await getSupabase()?.auth.signOut();
    await fetch("/api/steam/pending", { method: "DELETE", credentials: "include" }).catch(
      () => {},
    );
    setSteamId(null);
    try {
      window.localStorage.removeItem("gg:recent-chats-cache");
    } catch {}
    onSignedOut();
  }, [onSignedOut]);

  return {
    user,
    authReady,
    steamId,
    supabaseReady,
    steamConnected,
    refreshSteamStatus,
    linkSteamToAccount,
    loginWithSteam,
    connectSteam,
    signOut,
  };
}
