"use client";

import type { User } from "@supabase/supabase-js";
import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";

import { AuthPanel } from "@/app/auth-panel";
import { IconArrowLeft } from "@/app/icons";
import { ProfileMenu } from "@/app/profile-menu";
import { ConfirmDialog, useConfirmDialog } from "@/app/use-confirm-dialog";
import { Snackbar } from "@/app/snackbar";
import { applyPlayerJourneyEnabled } from "@/lib/player-journey-client.js";
import { loadVisualAuto } from "@/lib/visual-search-prefs.js";
import {
  journeyEnabledFromUserMetadata,
  loadJourneyEnabled,
  saveJourneyEnabled,
} from "@/lib/player-journey-prefs.js";
import { getSupabase } from "@/lib/supabase";

type Props = {
  backHref: string;
  backLabel: string;
  pageClassName?: string;
  user: User | null;
  supabaseReady: boolean;
  spoilerMajor: boolean;
  authOpen: boolean;
  onAuthOpen: () => void;
  onAuthClose: () => void;
  onSpoilerChange: (value: boolean) => void;
  onSignOut: () => void;
  onJourneyEnabledChange?: (enabled: boolean) => void;
  children: ReactNode;
};

export function ProfileShell({
  backHref,
  backLabel,
  pageClassName,
  user,
  supabaseReady,
  spoilerMajor,
  authOpen,
  onAuthOpen,
  onAuthClose,
  onSpoilerChange,
  onSignOut,
  onJourneyEnabledChange,
  children,
}: Props) {
  const [visualAuto, setVisualAuto] = useState(true);
  const [journeyEnabled, setJourneyEnabled] = useState(false);
  const [notice, setNotice] = useState("");
  const { confirmState, askConfirm, closeConfirm } = useConfirmDialog();

  useEffect(() => {
    setVisualAuto(loadVisualAuto());
    setJourneyEnabled(loadJourneyEnabled());
  }, []);
  useEffect(() => {
    if (!user) return;
    const remote = journeyEnabledFromUserMetadata(user.user_metadata);
    if (remote !== null) {
      setJourneyEnabled(remote);
      saveJourneyEnabled(remote);
      return;
    }
    setJourneyEnabled(loadJourneyEnabled());
  }, [user]);

  async function updateJourneyEnabled(next: boolean) {
    if (next === journeyEnabled) return;
    const supabase = getSupabase();
    const result = await applyPlayerJourneyEnabled({
      supabase,
      userId: user?.id,
      next,
      confirmDisable: (message) => askConfirm(message, "Turn off", true),
      onError: setNotice,
    });
    if (!result.ok) return;
    if (result.cancelled) return;
    setJourneyEnabled(result.enabled ?? next);
    onJourneyEnabledChange?.(result.enabled ?? next);
  }

  return (
    <main className={pageClassName ? `profile-page-shell ${pageClassName}` : "profile-page-shell"}>
      <nav className="nav" aria-label="Brand">
        <div className="nav-left">
          <Link className="profile-back icon-inline" href={backHref}>
            <IconArrowLeft /> {backLabel}
          </Link>
        </div>
        <div className="nav-actions">
          <ProfileMenu
            user={user}
            supabaseReady={supabaseReady}
            spoilerMajor={spoilerMajor}
            onSpoilerChange={onSpoilerChange}
            visualAuto={visualAuto}
            onVisualAutoChange={setVisualAuto}
            journeyEnabled={journeyEnabled}
            onJourneyChange={(next) => void updateJourneyEnabled(next)}
            onSignIn={onAuthOpen}
            onSignOut={() => void onSignOut()}
          />
        </div>
      </nav>

      <section className="profile-page">{children}</section>

      {authOpen && supabaseReady ? <AuthPanel onClose={onAuthClose} /> : null}
      {confirmState ? (
        <ConfirmDialog
          state={confirmState}
          onCancel={() => closeConfirm(false)}
          onConfirm={(checked) => closeConfirm(true, checked)}
        />
      ) : null}
      <Snackbar message={notice} onDismiss={() => setNotice("")} />
    </main>
  );
}
