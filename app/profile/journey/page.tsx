"use client";

import { useEffect, useState } from "react";

import { Snackbar } from "@/app/snackbar";
import { PlayerJourneySection } from "@/app/profile/player-journey-section";
import { ProfileShell } from "@/app/profile/profile-shell";
import { useProfileSession } from "@/app/profile/use-profile-session";
import {
  journeyEnabledFromUserMetadata,
  loadJourneyEnabled,
} from "@/lib/player-journey-prefs.js";

export default function ProfileJourneyPage() {
  const {
    user,
    spoilerMajor,
    supabaseReady,
    authOpen,
    setAuthOpen,
    updateSpoiler,
    signOut,
  } = useProfileSession();
  const [notice, setNotice] = useState("");
  const [journeyEnabled, setJourneyEnabled] = useState(false);

  useEffect(() => {
    if (!user) {
      setJourneyEnabled(loadJourneyEnabled());
      return;
    }
    const remote = journeyEnabledFromUserMetadata(user.user_metadata);
    setJourneyEnabled(remote ?? loadJourneyEnabled());
  }, [user]);

  return (
    <ProfileShell
      backHref="/profile"
      backLabel="Profile"
      pageClassName="player-journey-page"
      user={user}
      supabaseReady={supabaseReady}
      spoilerMajor={spoilerMajor}
      authOpen={authOpen}
      onAuthOpen={() => setAuthOpen(true)}
      onAuthClose={() => setAuthOpen(false)}
      onSpoilerChange={updateSpoiler}
      onSignOut={signOut}
      onJourneyEnabledChange={setJourneyEnabled}
    >
      {!supabaseReady ? (
        <p className="profile-hint">Accounts are not configured on this server.</p>
      ) : !user ? (
        <div className="profile-card">
          <h1>Track my progress</h1>
          <p className="profile-hint">Sign in to manage your per-game progress journals.</p>
          <button type="button" className="nav-button" onClick={() => setAuthOpen(true)}>
            Sign in
          </button>
        </div>
      ) : (
        <div className="profile-card player-journey-card">
          <header className="player-memory-page-head">
            <h1>Track my progress</h1>
            <p className="profile-hint">Edit journals saved from your game chats.</p>
          </header>
          <PlayerJourneySection
            user={user}
            journeyEnabled={journeyEnabled}
            onToast={setNotice}
          />
        </div>
      )}
      <Snackbar message={notice} onDismiss={() => setNotice("")} />
    </ProfileShell>
  );
}
