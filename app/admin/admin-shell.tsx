"use client";

import Link from "next/link";
import type { User } from "@supabase/supabase-js";
import { IconArrowLeft } from "@/app/icons";
import { AdminTabs } from "@/app/admin/admin-tabs";
import { ModelPicker } from "@/app/admin/model-picker";
import { isAdminEmail } from "@/lib/admin-constants";

type AdminShellProps = {
  user: User | null;
  loading: boolean;
  children: React.ReactNode;
  actions?: React.ReactNode;
  subtitle?: string;
};

export function AdminShell({ user, loading, children, actions, subtitle }: AdminShellProps) {
  const isAdmin = isAdminEmail(user?.email);

  if (loading) {
    return (
      <main className="profile-page-shell">
        <nav className="nav" aria-label="Brand">
          <div className="nav-left">
            <Link className="profile-back icon-inline" href="/">
              <IconArrowLeft /> Home
            </Link>
          </div>
        </nav>
        <section className="profile-page" style={{ maxWidth: "1000px", margin: "0 auto", padding: "0 20px", width: "100%" }}>
          <p className="profile-hint" style={{ textAlign: "center", marginTop: "2rem" }}>
            Loading dashboard...
          </p>
        </section>
      </main>
    );
  }

  if (!user || !isAdmin) {
    return (
      <main className="profile-page-shell">
        <nav className="nav" aria-label="Brand">
          <div className="nav-left">
            <Link className="profile-back icon-inline" href="/">
              <IconArrowLeft /> Home
            </Link>
          </div>
        </nav>
        <section className="profile-page">
          <div className="profile-card">
            <h1>Admin access</h1>
            <p className="profile-hint">
              {user
                ? "Your account does not have permission to view the admin dashboard."
                : "Sign in with the admin account to continue."}
            </p>
            {!user && (
              <Link
                href="/profile"
                className="nav-button"
                style={{ display: "flex", justifyContent: "center", alignItems: "center", padding: "12px", fontSize: "0.85rem" }}
              >
                Go to profile to sign in
              </Link>
            )}
          </div>
        </section>
      </main>
    );
  }

  return (
    <main className="admin-page-shell">
      <nav className="nav" aria-label="Brand">
        <div className="nav-left">
          <Link className="profile-back icon-inline" href="/">
            <IconArrowLeft /> Home
          </Link>
        </div>
        <div className="nav-actions">{actions}</div>
      </nav>

      <section className="admin-page">
        <div className="profile-card admin-card">
          <div className="admin-head">
            <div>
              <h1>Admin dashboard</h1>
              <p className="profile-hint">
                {subtitle ??
                  "Player activity, LLM prompts, and pipeline detail. Use Live traces for a flat event stream."}
              </p>
            </div>
            <AdminTabs />
          </div>
          <ModelPicker />
          {children}
        </div>
      </section>
    </main>
  );
}
