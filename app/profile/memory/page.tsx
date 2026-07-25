"use client";

import { useState } from "react";

import { Snackbar } from "@/app/snackbar";
import { PlayerMemorySection } from "@/app/profile/player-memory-section";
import { ProfileShell } from "@/app/profile/profile-shell";
import { useProfileSession } from "@/app/profile/use-profile-session";

export default function ProfileMemoryPage() {
  const {
    user,
    session,
    spoilerMajor,
    supabaseReady,
    authOpen,
    setAuthOpen,
    updateSpoiler,
    signOut,
  } = useProfileSession();
  const [notice, setNotice] = useState("");

  return (
    <ProfileShell
      backHref="/profile"
      backLabel="Profile"
      pageClassName="player-memory-page"
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
          <h1>Learn my style</h1>
          <p className="profile-hint">Sign in to manage what the guide remembers about you.</p>
          <button type="button" className="nav-button" onClick={() => setAuthOpen(true)}>
            Sign in
          </button>
        </div>
      ) : (
        <div className="profile-card player-memory-card">
          <header className="player-memory-page-head">
            <h1>Learn my style</h1>
            <p className="profile-hint">Tailor answers to how you ask questions.</p>
          </header>
          <PlayerMemorySection session={session} onToast={setNotice} />
        </div>
      )}
      <Snackbar message={notice} onDismiss={() => setNotice("")} />
    </ProfileShell>
  );
}
