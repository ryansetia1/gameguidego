"use client";

import { FormEvent, useEffect, useRef, useState } from "react";

import { getSupabase } from "@/lib/supabase";

type Props = {
  onClose: () => void;
};

export function AuthPanel({ onClose }: Props) {
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const emailRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    emailRef.current?.focus();
  }, []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const supabase = getSupabase();
    if (!supabase || busy) return;

    setError("");
    setNotice("");
    setBusy(true);
    try {
      if (mode === "signup") {
        const { data, error: signUpError } = await supabase.auth.signUp({
          email,
          password,
        });
        if (signUpError) throw signUpError;
        // No session means email confirmation is enabled on the project.
        if (!data.session) {
          setNotice("Check your email to confirm your account, then sign in.");
          setMode("signin");
          return;
        }
        onClose();
      } else {
        const { error: signInError } = await supabase.auth.signInWithPassword({
          email,
          password,
        });
        if (signInError) throw signInError;
        onClose();
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  async function onGoogle() {
    const supabase = getSupabase();
    if (!supabase || busy) return;
    setError("");
    setBusy(true);
    const { error: oauthError } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: window.location.origin },
    });
    if (oauthError) {
      setError(oauthError.message);
      setBusy(false);
    }
    // On success the browser redirects to Google, so no further work here.
  }

  return (
    <div
      className="auth-overlay"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="auth-modal" role="dialog" aria-modal="true" aria-label="Account">
        <button
          type="button"
          className="auth-close"
          aria-label="Close"
          onClick={onClose}
        >
          ×
        </button>
        <h2 className="auth-title">
          {mode === "signin" ? "Sign in" : "Create account"}
        </h2>
        <p className="auth-sub">Save your game chats and pick up where you left off.</p>

        <button type="button" className="auth-google" onClick={onGoogle} disabled={busy}>
          Continue with Google
        </button>
        {/* Steam is a link action, not a sign-in — offered as "Connect Steam" in
            the sidebar once signed in, so it's kept out of this logged-out modal. */}
        <p className="auth-steam-hint">Playing on Steam? Sign in here first, then link your Steam library from the menu.</p>

        <div className="auth-divider">
          <span>or</span>
        </div>

        <form onSubmit={onSubmit}>
          <label className="auth-field">
            <span>Email</span>
            <input
              ref={emailRef}
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              autoComplete="email"
              required
              disabled={busy}
            />
          </label>
          <label className="auth-field">
            <span>Password</span>
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete={mode === "signin" ? "current-password" : "new-password"}
              minLength={6}
              required
              disabled={busy}
            />
          </label>

          {error && (
            <p className="auth-error" role="alert">
              {error}
            </p>
          )}
          {notice && <p className="auth-notice">{notice}</p>}

          <button type="submit" className="auth-submit" disabled={busy}>
            {busy ? "Working..." : mode === "signin" ? "Sign in" : "Create account"}
          </button>
        </form>

        <p className="auth-switch">
          {mode === "signin" ? "New here?" : "Already have an account?"}{" "}
          <button
            type="button"
            onClick={() => {
              setError("");
              setNotice("");
              setMode(mode === "signin" ? "signup" : "signin");
            }}
          >
            {mode === "signin" ? "Create an account" : "Sign in"}
          </button>
        </p>
      </div>
    </div>
  );
}
