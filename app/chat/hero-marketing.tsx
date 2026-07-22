"use client";

import { useEffect, useRef, useState } from "react";
import { FUN_ROLES, HERO_LINES, HOME_TIPS } from "@/lib/hero-copy.js";
import { lerpTilt, mouseToTilt, orientationToTilt, tiltTransform } from "@/lib/hero-tilt.js";

function HeadlineText({
  lead,
  payoff,
  echo = false,
}: {
  lead: string;
  payoff: string;
  echo?: boolean;
}) {
  return (
    <>
      <span className={`hero-headline-lead${echo ? "" : " hero-headline-lead--front"}`}>{lead}</span>
      <span
        className={
          echo
            ? "hero-headline-payoff-text hero-headline-payoff-text--echo"
            : "hero-headline-payoff-text"
        }
      >
        {payoff}
      </span>
    </>
  );
}

export function RotatingHeadline() {
  const [i, setI] = useState(0);
  const wrapRef = useRef<HTMLDivElement>(null);
  const linesRef = useRef<HTMLDivElement>(null);
  const targetRef = useRef({ x: 0, y: 0 });
  const currentRef = useRef({ x: 0, y: 0 });
  const rafRef = useRef(0);

  useEffect(() => {
    setI(Math.floor(Math.random() * HERO_LINES.length));
  }, []);

  useEffect(() => {
    const linesEl = linesRef.current;
    if (!linesEl || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    let alive = true;

    const tick = () => {
      if (!alive) return;
      const next = lerpTilt(currentRef.current, targetRef.current);
      const settled = next.x === targetRef.current.x && next.y === targetRef.current.y;
      currentRef.current = next;
      linesEl.style.transform = tiltTransform(next);
      if (!settled) rafRef.current = requestAnimationFrame(tick);
    };

    const nudge = () => {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(tick);
    };

    const cleanup = () => {
      alive = false;
      cancelAnimationFrame(rafRef.current);
      linesEl.style.transform = "";
    };

    if (window.matchMedia("(pointer: fine)").matches) {
      const onMove = (event: globalThis.MouseEvent) => {
        targetRef.current = mouseToTilt(
          event.clientX,
          event.clientY,
          window.innerWidth,
          window.innerHeight,
        );
        nudge();
      };
      const onLeave = () => {
        targetRef.current = { x: 0, y: 0 };
        nudge();
      };
      window.addEventListener("mousemove", onMove, { passive: true });
      document.addEventListener("mouseleave", onLeave);
      return () => {
        window.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseleave", onLeave);
        cleanup();
      };
    }

    const onOrient = (event: DeviceOrientationEvent) => {
      targetRef.current = orientationToTilt(event.beta, event.gamma);
      nudge();
    };

    const startGyro = () => {
      window.addEventListener("deviceorientation", onOrient, { passive: true });
    };

    const stopGyro = () => {
      window.removeEventListener("deviceorientation", onOrient);
    };

    const DOE = DeviceOrientationEvent as typeof DeviceOrientationEvent & {
      requestPermission?: () => Promise<PermissionState>;
    };

    if (typeof DOE.requestPermission === "function") {
      const wrap = wrapRef.current;
      if (!wrap) return cleanup;
      const ask = () => {
        void DOE.requestPermission!()
          .then((state) => {
            if (state === "granted") startGyro();
          })
          .catch(() => {});
      };
      wrap.addEventListener("pointerdown", ask, { once: true });
      return () => {
        wrap.removeEventListener("pointerdown", ask);
        stopGyro();
        cleanup();
      };
    }

    startGyro();
    return () => {
      stopGyro();
      cleanup();
    };
  }, []);

  const [lead, payoff] = HERO_LINES[i];
  return (
    <div ref={wrapRef} className="hero-headline-wrap">
      <h1 className="hero-headline">
        <div className="hero-headline-inner">
          <div ref={linesRef} className="hero-headline-lines">
            <div className="hero-headline-layer hero-headline-layer--back" aria-hidden="true">
              <HeadlineText lead={lead} payoff={payoff} echo />
            </div>
            <div className="hero-headline-layer hero-headline-layer--mid" aria-hidden="true">
              <HeadlineText lead={lead} payoff={payoff} echo />
            </div>
            <div className="hero-headline-layer hero-headline-layer--front">
              <HeadlineText lead={lead} payoff={payoff} />
            </div>
          </div>
          <span className="hero-headline-highlight" aria-hidden="true">
            <span className="hero-headline-lead hero-headline-ghost">{lead}</span>
            <span className="hero-headline-payoff-text hero-headline-ghost">{payoff}</span>
          </span>
        </div>
      </h1>
    </div>
  );
}

export function RotatingWord() {
  const [i, setI] = useState(0);
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    if (paused) return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const id = setInterval(() => setI((n) => (n + 1) % FUN_ROLES.length), 2200);
    return () => clearInterval(id);
  }, [paused]);
  return (
    <button
      type="button"
      className="rotating-word"
      onClick={() => setPaused((p) => !p)}
      title={paused ? "Resume" : "Tap to pause"}
      aria-label={
        paused
          ? `Paused on "${FUN_ROLES[i]}". Activate to resume.`
          : "Rotating word — activate to pause."
      }
    >
      <span key={i} className="rotating-word-inner">
        {FUN_ROLES[i]}
      </span>
    </button>
  );
}

/** Ambient one-line tip at the bottom of quick-home. Picks a fresh tip per open;
 *  index 0 is the SSR-stable default so hydration matches. */
export function HomeTip() {
  const [i, setI] = useState(0);
  useEffect(() => {
    setI(Math.floor(Math.random() * HOME_TIPS.length));
  }, []);
  return (
    <p className="home-tip">
      <span className="home-tip-label">Tip</span>
      {HOME_TIPS[i]}
    </p>
  );
}

export function SteamIcon() {
  return (
    <svg className="sidebar-steam-icon" viewBox="0 0 496 512" fill="currentColor" aria-hidden="true">
      <path d="M496 256c0 137-111.2 248-248.4 248-113.8 0-209.6-76.3-239-180.4l95.2 39.3c6.4 32.1 34.9 56.4 68.9 56.4 39.2 0 71.9-32.4 70.2-73.5l84.5-60.2c52.1 1.3 95.8-40.9 95.8-93.5 0-51.6-42-93.5-93.7-93.5s-93.7 42-93.7 93.5v1.2L176.6 279c-15.5-.9-30.7 3.4-43.5 12.1L0 236.1C10.2 108.4 117.1 8 247.6 8 384.8 8 496 119 496 256zM155.7 384.3l-30.5-12.6a52.79 52.79 0 0 0 27.2 25.8c26.9 11.2 57.8-1.6 69-28.5 5.4-13 5.5-27.3.1-40.3-5.4-13-15.5-23.2-28.5-28.6-12.9-5.4-26.7-5.2-38.9-.6l31.5 13c19.8 8.2 29.2 30.9 20.9 50.7-8.3 19.9-31 29.2-50.8 20.9v.2zm173.6-129.9c-34.4 0-62.4-28-62.4-62.3s28-62.3 62.4-62.3 62.4 28 62.4 62.3-27.9 62.3-62.4 62.3zm.1-15.6c25.9 0 46.9-21 46.9-46.8 0-25.9-21-46.8-46.9-46.8s-46.9 21-46.9 46.8c0 25.8 21 46.8 46.9 46.8z" />
    </svg>
  );
}
