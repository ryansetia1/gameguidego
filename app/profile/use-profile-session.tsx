"use client";

import type { Session, User } from "@supabase/supabase-js";
import { useCallback, useEffect, useState } from "react";

import {
  DEFAULT_SPOILER_PREFS,
  loadGlobalSpoilerPrefs,
  saveGlobalSpoilerPrefs,
  spoilerMajorFromUserMetadata,
} from "@/lib/spoiler-prefs.js";
import { getSupabase } from "@/lib/supabase";

export function useProfileSession() {
  const [user, setUser] = useState<User | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [spoilerMajor, setSpoilerMajor] = useState(DEFAULT_SPOILER_PREFS.major);
  const [authOpen, setAuthOpen] = useState(false);

  const supabaseReady = Boolean(getSupabase());

  useEffect(() => {
    const supabase = getSupabase();
    if (!supabase) return;
    let mounted = true;
    supabase.auth.getSession().then(({ data }) => {
      if (!mounted) return;
      const nextUser = data.session?.user ?? null;
      setSession(data.session ?? null);
      setUser(nextUser);
      if (nextUser) {
        const remote = spoilerMajorFromUserMetadata(nextUser.user_metadata);
        setSpoilerMajor(remote ?? loadGlobalSpoilerPrefs().major);
      }
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      const nextUser = nextSession?.user ?? null;
      setSession(nextSession);
      setUser(nextUser);
    });
    return () => {
      mounted = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  const updateSpoiler = useCallback((value: boolean) => {
    setSpoilerMajor(value);
    saveGlobalSpoilerPrefs({ major: value });
  }, []);

  const signOut = useCallback(async () => {
    await getSupabase()?.auth.signOut();
  }, []);

  return {
    user,
    setUser,
    session,
    spoilerMajor,
    supabaseReady,
    authOpen,
    setAuthOpen,
    updateSpoiler,
    signOut,
  };
}
