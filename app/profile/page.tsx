"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";

import { ClearButton } from "@/app/clear-button";
import { PlayerMemoryLink } from "@/app/profile/player-memory-link";
import { ProfileShell } from "@/app/profile/profile-shell";
import { useProfileSession } from "@/app/profile/use-profile-session";
import { compressImage } from "@/lib/image.js";
import {
  avatarInitialFromUser,
  avatarSourcesFromUser,
  avatarUrlFromUser,
  coerceDisplayName,
  displayNameFromMetadata,
  MAX_DISPLAY_NAME_LENGTH,
} from "@/lib/profile.js";
import { getSupabase } from "@/lib/supabase";
import {
  loadVoiceLang,
  saveVoiceLang,
  VOICE_LANGUAGES,
  voiceLangFromUserMetadata,
} from "@/lib/voice.js";

export default function ProfilePage() {
  const {
    user,
    setUser,
    session,
    spoilerMajor,
    supabaseReady,
    authOpen,
    setAuthOpen,
    updateSpoiler,
    signOut,
  } = useProfileSession();
  const [displayName, setDisplayName] = useState("");
  const [voiceLang, setVoiceLang] = useState("");
  const [saving, setSaving] = useState(false);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (!user) return;
    setDisplayName(displayNameFromMetadata(user.user_metadata));
    setVoiceLang(voiceLangFromUserMetadata(user.user_metadata) || loadVoiceLang());
  }, [user]);

  const updateVoiceLang = useCallback((value: string) => {
    setVoiceLang(value);
    saveVoiceLang(value);
    void getSupabase()?.auth.updateUser({ data: { voice_lang: value || null } });
  }, []);

  // Which stored avatar to display (Google / Steam / uploaded). Writing the
  // choice to avatar_pref is all it takes — avatarUrlFromUser honours it.
  async function chooseAvatar(pref: "google" | "steam" | "upload") {
    const supabase = getSupabase();
    if (!supabase || !user) return;
    setError("");
    const { data, error: prefError } = await supabase.auth.updateUser({
      data: { avatar_pref: pref },
    });
    if (prefError) {
      setError(prefError.message);
      return;
    }
    if (data.user) setUser(data.user);
  }

  async function onAvatarUpload(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    const supabase = getSupabase();
    if (!file || !supabase || !user || uploadingAvatar) return;
    setUploadingAvatar(true);
    setError("");
    setNotice("");
    try {
      const blob = await compressImage(file, 512, 0.85);
      const path = `${user.id}/avatar-${Date.now()}.jpg`;
      const { error: upError } = await supabase.storage
        .from("covers")
        .upload(path, blob, { upsert: true, contentType: "image/jpeg" });
      if (upError) throw upError;
      const url = supabase.storage.from("covers").getPublicUrl(path).data.publicUrl;
      const { data, error: saveError } = await supabase.auth.updateUser({
        data: { avatar_upload: url, avatar_pref: "upload" },
      });
      if (saveError) throw saveError;
      if (data.user) setUser(data.user);
      setNotice("Photo updated.");
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Upload failed. Make sure the 'covers' bucket exists.",
      );
    } finally {
      setUploadingAvatar(false);
    }
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
  const avatarSources = user ? avatarSourcesFromUser(user) : { google: null, steam: null, upload: null };
  const avatarChoices = (["google", "steam", "upload"] as const).filter(
    (source) => avatarSources[source],
  );

  return (
    <ProfileShell
      backHref="/"
      backLabel="Home"
      user={user}
      supabaseReady={supabaseReady}
      spoilerMajor={spoilerMajor}
      authOpen={authOpen}
      onAuthOpen={() => setAuthOpen(true)}
      onAuthClose={() => setAuthOpen(false)}
      onSpoilerChange={updateSpoiler}
      onSignOut={signOut}
    >
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
                <div className="field-clear-wrap">
                  <input
                    id="profile-display-name"
                    type="text"
                    value={displayName}
                    maxLength={MAX_DISPLAY_NAME_LENGTH}
                    placeholder="What should we call you?"
                    onChange={(event) => setDisplayName(event.target.value)}
                    autoComplete="nickname"
                  />
                  <ClearButton
                    show={displayName.length > 0}
                    onClear={() => {
                      setDisplayName("");
                      document.getElementById("profile-display-name")?.focus();
                    }}
                    label="Clear display name"
                  />
                </div>
              </label>
              {error && <p className="profile-error">{error}</p>}
              {notice && <p className="profile-notice">{notice}</p>}
              <button type="submit" className="nav-button" disabled={saving}>
                {saving ? "Saving…" : "Save"}
              </button>
            </form>

            <div className="field">
              <span className="field-label">Profile photo</span>
              <p className="field-hint">
                {avatarChoices.length > 1
                  ? "Pick which picture to show, or upload your own."
                  : "Upload a photo to use as your avatar."}
              </p>
              <div className="avatar-options">
                {avatarChoices.map((source) => (
                  <button
                    type="button"
                    key={source}
                    className={`avatar-option${avatarSources[source] === avatarUrl ? " is-active" : ""}`}
                    onClick={() => void chooseAvatar(source)}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={avatarSources[source] as string} alt="" />
                    <span>
                      {source === "google" ? "Google" : source === "steam" ? "Steam" : "Upload"}
                    </span>
                  </button>
                ))}
                <label className="avatar-option avatar-option-upload">
                  <span aria-hidden="true">+</span>
                  <span>{uploadingAvatar ? "Uploading…" : "Upload"}</span>
                  <input
                    type="file"
                    accept="image/*"
                    hidden
                    disabled={uploadingAvatar}
                    onChange={(event) => void onAvatarUpload(event)}
                  />
                </label>
              </div>
            </div>

            <label className="field">
              <span className="field-label">Voice input language</span>
              <p className="field-hint">
                Language for the mic button dictation. Saved to your account.
              </p>
              <select
                value={voiceLang}
                onChange={(event) => updateVoiceLang(event.target.value)}
              >
                <option value="">Ask me the first time</option>
                {VOICE_LANGUAGES.map((entry) => (
                  <option key={entry.code} value={entry.code}>
                    {entry.label}
                  </option>
                ))}
              </select>
            </label>

            <PlayerMemoryLink session={session} />
          </div>
        )}
    </ProfileShell>
  );
}
