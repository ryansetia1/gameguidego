"use client";

import type { User } from "@supabase/supabase-js";
import Link from "next/link";
import { FormEvent, useCallback, useEffect, useState } from "react";

import { AuthPanel } from "@/app/auth-panel";
import { ProfileMenu } from "@/app/profile-menu";
import {
  avatarInitialFromUser,
  avatarUrlFromUser,
  coerceDisplayName,
  displayNameFromMetadata,
  MAX_DISPLAY_NAME_LENGTH,
} from "@/lib/profile.js";
import {
  DEFAULT_SPOILER_PREFS,
  loadSpoilerPrefs,
  saveSpoilerPrefs,
  spoilerMajorFromUserMetadata,
} from "@/lib/spoiler-prefs.js";
import { getSupabase } from "@/lib/supabase";

export default function ProfilePage() {
  const [user, setUser] = useState<User | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [spoilerMajor, setSpoilerMajor] = useState(DEFAULT_SPOILER_PREFS.major);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [authOpen, setAuthOpen] = useState(false);

  const supabaseReady = Boolean(getSupabase());

  useEffect(() => {
    const supabase = getSupabase();
    if (!supabase) return;
    let mounted = true;
    supabase.auth.getSession().then(({ data }) => {
      if (!mounted) return;
      const nextUser = data.session?.user ?? null;
      setUser(nextUser);
      if (nextUser) {
        setDisplayName(displayNameFromMetadata(nextUser.user_metadata));
        const remote = spoilerMajorFromUserMetadata(nextUser.user_metadata);
        setSpoilerMajor(remote ?? loadSpoilerPrefs().major);
      }
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      const nextUser = session?.user ?? null;
      setUser(nextUser);
      if (nextUser) {
        setDisplayName(displayNameFromMetadata(nextUser.user_metadata));
      }
    });
    return () => {
      mounted = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  const updateSpoiler = useCallback((value: boolean) => {
    setSpoilerMajor(value);
    saveSpoilerPrefs({ major: value });
  }, []);

  async function signOut() {
    await getSupabase()?.auth.signOut();
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const supabase = getSupabase();
    if (!supabase || !user || saving) return;

    const trimmed = coerceDisplayName(displayName);
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const { data, error: updateError } = await supabase.auth.updateUser({
        data: { display_name: trimmed || null },
      });
      if (updateError) throw updateError;
      if (data.user) setUser(data.user);
      setDisplayName(trimmed);
      setNotice(trimmed ? "Saved. The guide will use this name." : "Saved.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save profile.");
    } finally {
      setSaving(false);
    }
  }

  const avatarUrl = user ? avatarUrlFromUser(user) : null;
  const initial = user ? avatarInitialFromUser(user) : "?";

  return (
    <main className="profile-page-shell">
      <nav className="nav" aria-label="Brand">
        <div className="nav-left">
          <Link className="profile-back" href="/">
            ← Home
          </Link>
        </div>
        <div className="nav-actions">
          <ProfileMenu
            user={user}
            supabaseReady={supabaseReady}
            spoilerMajor={spoilerMajor}
            onSpoilerChange={updateSpoiler}
            onSignIn={() => setAuthOpen(true)}
            onSignOut={() => void signOut()}
          />
        </div>
      </nav>

      <section className="profile-page">
        {!supabaseReady ? (
          <p className="profile-hint">Accounts are not configured on this server.</p>
        ) : !user ? (
          <div className="profile-card">
            <h1>Profile</h1>
            <p className="profile-hint">Sign in to set a display name for the guide.</p>
            <button type="button" className="nav-button" onClick={() => setAuthOpen(true)}>
              Sign in
            </button>
          </div>
        ) : (
          <div className="profile-card">
            <div className="profile-hero">
              {avatarUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img className="profile-hero-avatar" src={avatarUrl} alt="" />
              ) : (
                <span className="profile-hero-avatar profile-avatar-fallback" aria-hidden="true">
                  {initial}
                </span>
              )}
              <div>
                <h1>Profile</h1>
                <p className="profile-email">{user.email}</p>
              </div>
            </div>

            <form className="profile-form" onSubmit={(event) => void onSubmit(event)}>
              <label className="field">
                <span className="field-label">Display name</span>
                <p className="field-hint">
                  The guide uses this in replies — e.g. &ldquo;Hey Ryan, try this&hellip;&rdquo;
                </p>
                <input
                  type="text"
                  value={displayName}
                  maxLength={MAX_DISPLAY_NAME_LENGTH}
                  placeholder="What should we call you?"
                  onChange={(event) => setDisplayName(event.target.value)}
                  autoComplete="nickname"
                />
              </label>
              {error && <p className="profile-error">{error}</p>}
              {notice && <p className="profile-notice">{notice}</p>}
              <button type="submit" className="nav-button" disabled={saving}>
                {saving ? "Saving…" : "Save"}
              </button>
            </form>
          </div>
        )}
      </section>

      {authOpen && supabaseReady && <AuthPanel onClose={() => setAuthOpen(false)} />}
    </main>
  );
}
