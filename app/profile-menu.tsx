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
  GLOBAL_SPOILER_TOGGLE_LABEL,
  saveGlobalSpoilerMajor,
  saveGlobalSpoilerPrefs,
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
  const [themeOpen, setThemeOpen] = useState(false);
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
    if (!open && !themeOpen) return;
    function onPointerDown(event: PointerEvent) {
      if (!wrapRef.current?.contains(event.target as Node)) {
        setOpen(false);
        setThemeOpen(false);
      }
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open, themeOpen]);

  function pickTheme(next: ThemeMode) {
    setThemeMode(next);
    saveTheme(next);
    setThemeOpen(false);
    if (user) void persistThemeForUser(next);
  }

  function toggleSpoiler() {
    const next = !spoilerMajor;
    onSpoilerChange(next);
    saveGlobalSpoilerMajor(next);
    saveGlobalSpoilerPrefs({ major: next });
    if (user) void persistSpoilerForUser(next);
  }

  function handleSignOut() {
    setOpen(false);
    onSignOut();
  }

  const avatarUrl = user ? avatarUrlFromUser(user) : null;
  const displayName = user ? displayNameFromMetadata(user.user_metadata) : "";
  const initial = user ? avatarInitialFromUser(user) : "?";
  const themeIcon = THEME_OPTIONS.find((option) => option.mode === themeMode)?.icon ?? "◐";

  return (
    <div className="nav-account-wrap" ref={wrapRef}>
      <div className="theme-toggle-wrap">
        <button
          type="button"
          className="nav-icon-btn theme-toggle"
          aria-label="Theme"
          aria-expanded={themeOpen}
          aria-haspopup="menu"
          onClick={() => {
            setOpen(false);
            setThemeOpen((value) => !value);
          }}
        >
          <span aria-hidden="true">{themeIcon}</span>
        </button>

        {themeOpen && (
          <div className="theme-toggle-menu" role="menu" aria-label="Theme">
            {THEME_OPTIONS.map((option) => (
              <button
                key={option.mode}
                type="button"
                role="menuitemradio"
                aria-checked={themeMode === option.mode}
                className={themeMode === option.mode ? "active" : undefined}
                onClick={() => pickTheme(option.mode)}
              >
                <span aria-hidden="true">{option.icon}</span> {option.label}
              </button>
            ))}
          </div>
        )}
      </div>

      {user ? (
        <div className="profile-menu-wrap">
          <button
            type="button"
            className="nav-icon-btn profile-menu-trigger"
            aria-label="Account menu"
            aria-expanded={open}
            aria-haspopup="menu"
            onClick={() => {
              setThemeOpen(false);
              setOpen((value) => !value);
            }}
          >
            {avatarUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img className="profile-avatar" src={avatarUrl} alt="" />
            ) : (
              <span className="profile-avatar profile-avatar-fallback" aria-hidden="true">
                {initial}
              </span>
            )}
          </button>

          {open && (
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
                <span>{GLOBAL_SPOILER_TOGGLE_LABEL}</span>
                <input
                  type="checkbox"
                  checked={spoilerMajor}
                  onChange={toggleSpoiler}
                  aria-label={GLOBAL_SPOILER_TOGGLE_LABEL}
                />
              </label>

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
      ) : supabaseReady ? (
        <button type="button" className="nav-button" onClick={onSignIn}>
          Sign in
        </button>
      ) : null}
    </div>
  );
}
