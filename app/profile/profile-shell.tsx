"use client";

import type { User } from "@supabase/supabase-js";
import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";

import { AuthPanel } from "@/app/auth-panel";
import { IconArrowLeft } from "@/app/icons";
import { ProfileMenu } from "@/app/profile-menu";
import { loadVisualAuto } from "@/lib/visual-search-prefs.js";

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
  children,
}: Props) {
  const [visualAuto, setVisualAuto] = useState(true);
  useEffect(() => {
    setVisualAuto(loadVisualAuto());
  }, []);
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
            onSignIn={onAuthOpen}
            onSignOut={() => void onSignOut()}
          />
        </div>
      </nav>

      <section className="profile-page">{children}</section>

      {authOpen && supabaseReady ? <AuthPanel onClose={onAuthClose} /> : null}
    </main>
  );
}
