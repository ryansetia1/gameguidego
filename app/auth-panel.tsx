"use client";

import { FormEvent, useEffect, useRef, useState } from "react";

import { getSupabase } from "@/lib/supabase";
import { IconX } from "./icons";

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
    const isApk = typeof navigator !== "undefined" && navigator.userAgent.includes("GameGuideGoAPK");
    const { error: oauthError } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: isApk ? `${window.location.origin}/?apk_auth=1` : window.location.origin,
      },
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
          <IconX />
        </button>
        <h2 className="auth-title">
          {mode === "signin" ? "Sign in" : "Create account"}
        </h2>
        <p className="auth-sub">Save your game chats and pick up where you left off.</p>

        <button type="button" className="auth-google" onClick={onGoogle} disabled={busy}>
          <svg className="auth-google-icon" viewBox="0 0 48 48" aria-hidden="true">
            <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
            <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
            <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
            <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
          </svg>
          Continue with Google
        </button>
        <button
          type="button"
          className="auth-steam"
          onClick={() => {
            // Open in a browser tab, not this window: from an installed PWA a
            // top-level nav to steamcommunity.com gets handed to the native Steam
            // app (which then returns to the browser, not us). A popup stays in
            // the browser and posts the result back here. Blocked -> full redirect.
            const isApk = typeof navigator !== "undefined" && navigator.userAgent.includes("GameGuideGoAPK");
            if (isApk) {
              window.location.href = "/api/steam/login?intent=signin&apk_auth=1";
              return;
            }
            const url = "/api/steam/login?intent=signin";
            const w = window.open(`${url}&popup=1`, "gg_steam_auth", "width=520,height=700");
            if (!w) window.location.href = url;
          }}
          disabled={busy}
        >
          <svg className="auth-steam-icon" viewBox="0 0 496 512" fill="currentColor" aria-hidden="true">
            <path d="M496 256c0 137-111.2 248-248.4 248-113.8 0-209.6-76.3-239-180.4l95.2 39.3c6.4 32.1 34.9 56.4 68.9 56.4 39.2 0 71.9-32.4 70.2-73.5l84.5-60.2c52.1 1.3 95.8-40.9 95.8-93.5 0-51.6-42-93.5-93.7-93.5s-93.7 42-93.7 93.5v1.2L176.6 279c-15.5-.9-30.7 3.4-43.5 12.1L0 236.1C10.2 108.4 117.1 8 247.6 8 384.8 8 496 119 496 256zM155.7 384.3l-30.5-12.6a52.79 52.79 0 0 0 27.2 25.8c26.9 11.2 57.8-1.6 69-28.5 5.4-13 5.5-27.3.1-40.3-5.4-13-15.5-23.2-28.5-28.6-12.9-5.4-26.7-5.2-38.9-.6l31.5 13c19.8 8.2 29.2 30.9 20.9 50.7-8.3 19.9-31 29.2-50.8 20.9v.2zm173.6-129.9c-34.4 0-62.4-28-62.4-62.3s28-62.3 62.4-62.3 62.4 28 62.4 62.3-27.9 62.3-62.4 62.3zm.1-15.6c25.9 0 46.9-21 46.9-46.8 0-25.9-21-46.8-46.9-46.8s-46.9 21-46.9 46.8c0 25.8 21 46.8 46.9 46.8z" />
          </svg>
          Continue with Steam
        </button>
        <p className="auth-steam-hint">Signing in with Steam pulls in your library automatically.</p>

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
