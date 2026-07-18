"use client";

import type { User } from "@supabase/supabase-js";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import {
  avatarInitialFromUser,
  avatarUrlFromUser,
  displayNameFromMetadata,
} from "@/lib/profile.js";
import {
  SPOILER_TOGGLE_LABEL,
  saveGlobalSpoilerMajor,
  saveSpoilerPrefs,
  spoilerMajorFromUserMetadata,
} from "@/lib/spoiler-prefs.js";
import { getSupabase } from "@/lib/supabase";
import {
  applyTheme,
  loadTheme,
  saveTheme,
  themeFromUserMetadata,
} from "@/lib/theme.js";

type ThemeMode = "system" | "light" | "dark";

const THEME_OPTIONS: { mode: ThemeMode; label: string; icon: string }[] = [
  { mode: "system", label: "System", icon: "◐" },
  { mode: "light", label: "Light", icon: "☀" },
  { mode: "dark", label: "Dark", icon: "☾" },
];

type Props = {
  user: User | null;
  supabaseReady: boolean;
  spoilerMajor: boolean;
  onSpoilerChange: (value: boolean) => void;
  onSignIn: () => void;
  onSignOut: () => void;
};

async function persistThemeForUser(mode: ThemeMode) {
  const supabase = getSupabase();
  if (!supabase) return;
  try {
    await supabase.auth.updateUser({ data: { theme: mode } });
  } catch (error) {
    console.error("Failed to save theme preference:", error);
  }
}

async function persistSpoilerForUser(major: boolean) {
  const supabase = getSupabase();
  if (!supabase) return;
  try {
    await supabase.auth.updateUser({ data: { spoiler_major: major } });
  } catch (error) {
    console.error("Failed to save spoiler preference:", error);
  }
}

export function ProfileMenu({
  user,
  supabaseReady,
  spoilerMajor,
  onSpoilerChange,
  onSignIn,
  onSignOut,
}: Props) {
  const [open, setOpen] = useState(false);
  const [themeMode, setThemeMode] = useState<ThemeMode>("system");
  const wrapRef = useRef<HTMLDivElement>(null);
  const pushedThemeRef = useRef(false);

  useEffect(() => {
    if (!user) {
      pushedThemeRef.current = false;
      const stored = loadTheme();
      setThemeMode(stored);
      applyTheme(stored);
      return;
    }

    const remoteTheme = themeFromUserMetadata(user.user_metadata);
    if (remoteTheme) {
      setThemeMode(remoteTheme);
      saveTheme(remoteTheme);
    } else {
      const local = loadTheme();
      setThemeMode(local);
      applyTheme(local);
      if (!pushedThemeRef.current && local !== "system") {
        pushedThemeRef.current = true;
        void persistThemeForUser(local);
      }
    }

    const remoteSpoiler = spoilerMajorFromUserMetadata(user.user_metadata);
    if (remoteSpoiler !== null) {
      onSpoilerChange(remoteSpoiler);
      saveGlobalSpoilerMajor(remoteSpoiler);
    }
  }, [onSpoilerChange, user]);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  function pickTheme(next: ThemeMode) {
    setThemeMode(next);
    saveTheme(next);
    if (user) void persistThemeForUser(next);
  }

  function toggleSpoiler() {
    const next = !spoilerMajor;
    onSpoilerChange(next);
    saveGlobalSpoilerMajor(next);
    saveSpoilerPrefs({ major: next });
    if (user) void persistSpoilerForUser(next);
  }

  function handleSignOut() {
    setOpen(false);
    onSignOut();
  }

  const avatarUrl = user ? avatarUrlFromUser(user) : null;
  const displayName = user ? displayNameFromMetadata(user.user_metadata) : "";
  const initial = user ? avatarInitialFromUser(user) : "?";

  return (
    <div className="profile-menu-wrap" ref={wrapRef}>
      <button
        type="button"
        className="profile-menu-trigger"
        aria-label={user ? "Account menu" : "Sign in"}
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => {
          if (!user && supabaseReady) {
            onSignIn();
            return;
          }
          setOpen((value) => !value);
        }}
      >
        {avatarUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img className="profile-avatar" src={avatarUrl} alt="" />
        ) : (
          <span className="profile-avatar profile-avatar-fallback" aria-hidden="true">
            {user ? initial : "◌"}
          </span>
        )}
      </button>

      {open && user && (
        <div className="profile-menu" role="menu">
          <div className="profile-menu-head">
            <strong>{displayName || user.email || "Your account"}</strong>
            {displayName && user.email && <small>{user.email}</small>}
          </div>

          <Link
            href="/profile"
            className="profile-menu-item"
            role="menuitem"
            onClick={() => setOpen(false)}
          >
            Profile
          </Link>

          <label className="profile-menu-item profile-menu-toggle">
            <span>{SPOILER_TOGGLE_LABEL}</span>
            <input
              type="checkbox"
              checked={spoilerMajor}
              onChange={toggleSpoiler}
              aria-label={SPOILER_TOGGLE_LABEL}
            />
          </label>

          <div className="profile-menu-section" role="group" aria-label="Theme">
            <span className="profile-menu-section-label">Theme</span>
            <div className="profile-menu-theme">
              {THEME_OPTIONS.map((option) => (
                <button
                  key={option.mode}
                  type="button"
                  role="menuitemradio"
                  aria-checked={themeMode === option.mode}
                  className={themeMode === option.mode ? "active" : undefined}
                  onClick={() => pickTheme(option.mode)}
                >
                  <span aria-hidden="true">{option.icon}</span>
                  {option.label}
                </button>
              ))}
            </div>
          </div>

          <button
            type="button"
            className="profile-menu-item profile-menu-signout"
            role="menuitem"
            onClick={handleSignOut}
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}
