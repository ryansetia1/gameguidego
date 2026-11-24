"use client";

import {
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import type { MapDownloadProgress, MapRef, MapViewport, OpenMapResult } from "./use-saved-maps";
import { MAX_MAP_BLOB_BYTES } from "@/lib/map-blob-cache.js";
import { formatSavingText } from "@/lib/maps-panel.js";
import {
  actualSizeScale,
  applyOverscrollResistance,
  calculateFitScale,
  calculateMapMaxZoom,
  calculateMapPanBounds,
  clampMapOffset,
  clampRestoredViewport,
  computeCanvasDrawRect,
  computeFocalZoomTransform,
  computeOverviewDimensions,
  doubleTapTargetScale,
  formatDimensionsLabel,
  formatMegabytes,
  formatZoomPercent,
  shouldRenderHdOverlay,
  wheelZoomFactor,
} from "@/lib/map-viewport.js";

export type MapViewerItem = {
  title: string;
  imageUrl: string;
  sourceUrl: string;
  dimensions?: string;
  width?: number | null;
  height?: number | null;
  savedId?: string | null;
  lastZoom?: number;
  lastOffsetX?: number;
  lastOffsetY?: number;
  /** Listed by VGMaps as over 30 MB: shown as a viewer state, never downloaded (#55 adds a fallback). */
  overLimit?: boolean;
};

export type MapViewerProps = {
  map: MapViewerItem | null;
  online: boolean;
  isSaved: boolean;
  openMap: (
    map: MapRef,
    signal?: AbortSignal,
    onProgress?: (progress: MapDownloadProgress) => void,
  ) => Promise<OpenMapResult>;
  cancelDownload?: (map: MapRef) => void;
  /** Progress of this map's save; the save itself runs page-level and survives closing. */
  saveProgress?: MapDownloadProgress | null;
  /** Start saving (absent when the map can't be saved from here). */
  onSave?: () => void;
  onViewportChange?: (savedId: string, state: MapViewport) => void;
  onClose: () => void;
  /** Rendered inside the dialog's top layer (the page toast while the viewer is open). */
  children?: ReactNode;
};

type ViewerState =
  | { kind: "loading"; big: boolean; phase: "downloading" | "preparing"; progress: MapDownloadProgress | null }
  | { kind: "ready"; naturalW: number; naturalH: number }
  | { kind: "offline" }
  | { kind: "too_large" }
  /** 404/400 from the proxy: VGMaps no longer lists this map. */
  | { kind: "unlisted" }
  /** Downloaded, but this device couldn't decode it (memory, corrupt file). */
  | { kind: "decode_failed" }
  | { kind: "failed" };

type DecodedAsset = {
  source: ImageBitmap | HTMLImageElement;
  isBitmap: boolean;
  overview: HTMLCanvasElement;
  overviewScale: number;
  naturalW: number;
  naturalH: number;
  objectUrl: string | null;
};

type BarInsets = { top: number; bottom: number; left: number; right: number };
type Transform = { scale: number; offset: { x: number; y: number } };
type PointerRecord = { x: number; y: number; startX: number; startY: number; pointerType: string };

const PIXEL_CRISP_KEY = "gg:map-pixel-crisp";
const BIG_LOAD_DELAY_MS = 400;
const HD_SETTLE_DELAY_MS = 85;
const WHEEL_SETTLE_DELAY_MS = 140;
const ZOOM_ANIM_MS = 160;
const BUTTON_ZOOM_STEP = 1.25;
const MAX_OVERSCROLL_PX = 24;
const DOUBLE_TAP_WINDOW_MS = 300;
const DOUBLE_TAP_MAX_DIST = 28;
const TAP_MAX_DRAG = 10;
const CANVAS_BG = "#0e1112";

// Unsaved maps keep their zoom/offset for this session (saved maps persist on the record).
const sessionViewports = new Map<string, MapViewport>();

// Session fallback when sessionStorage is unavailable (e.g. strict private browsing).
let memoryPixelCrisp = false;

function readSessionPixelCrisp(): boolean {
  if (typeof window === "undefined") return memoryPixelCrisp;
  try {
    return window.sessionStorage.getItem(PIXEL_CRISP_KEY) === "1";
  } catch {
    return memoryPixelCrisp;
  }
}

function writeSessionPixelCrisp(next: boolean) {
  memoryPixelCrisp = next;
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(PIXEL_CRISP_KEY, next ? "1" : "0");
  } catch {
    // Keep in-memory fallback for this session.
  }
}

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

function looksLikeMemoryDecodeError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const name = String((err as { name?: unknown }).name ?? "");
  const msg = String((err as { message?: unknown }).message ?? "").toLowerCase();
  return (
    name === "RangeError" ||
    name === "QuotaExceededError" ||
    msg.includes("memory") ||
    msg.includes("too large") ||
    msg.includes("allocation")
  );
}

function disposeAsset(asset: DecodedAsset | null) {
  if (!asset) return;
  if (asset.isBitmap) {
    try {
      (asset.source as ImageBitmap).close();
    } catch {
      // Already closed.
    }
  }
  if (asset.objectUrl) {
    URL.revokeObjectURL(asset.objectUrl);
  }
  asset.overview.width = 0;
  asset.overview.height = 0;
}

async function decodeImageElement(objectUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = "async";
    img.onload = () => {
      if (img.naturalWidth > 0 && img.naturalHeight > 0) resolve(img);
      else reject(new Error("Decoded empty image."));
    };
    img.onerror = () => reject(new Error("Image decode failed."));
    img.src = objectUrl;
  });
}

async function decodeMapAsset(blob: Blob, objectUrl: string): Promise<DecodedAsset> {
  let source: ImageBitmap | HTMLImageElement;
  let isBitmap = false;
  let retainedUrl: string | null = objectUrl;

  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(blob);
      if (bitmap.width > 0 && bitmap.height > 0) {
        source = bitmap;
        isBitmap = true;
        // Bitmap owns its decoded pixels; release the blob URL immediately.
        URL.revokeObjectURL(objectUrl);
        retainedUrl = null;
      } else {
        bitmap.close();
        source = await decodeImageElement(objectUrl);
      }
    } catch (bitmapErr) {
      if (looksLikeMemoryDecodeError(bitmapErr)) {
        URL.revokeObjectURL(objectUrl);
        throw bitmapErr;
      }
      source = await decodeImageElement(objectUrl);
    }
  } else {
    source = await decodeImageElement(objectUrl);
  }

  const naturalW = isBitmap ? (source as ImageBitmap).width : (source as HTMLImageElement).naturalWidth;
  const naturalH = isBitmap ? (source as ImageBitmap).height : (source as HTMLImageElement).naturalHeight;
  const ov = computeOverviewDimensions(naturalW, naturalH, 2048);
  const overview = document.createElement("canvas");
  overview.width = ov.width;
  overview.height = ov.height;
  const cleanupPartial = () => {
    if (isBitmap) {
      try {
        (source as ImageBitmap).close();
      } catch {
        // Already closed.
      }
    }
    if (retainedUrl) URL.revokeObjectURL(retainedUrl);
    overview.width = 0;
    overview.height = 0;
  };
  const ctx = overview.getContext("2d");
  if (!ctx) {
    cleanupPartial();
    throw new RangeError("Canvas allocation failed.");
  }
  try {
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(source, 0, 0, ov.width, ov.height);
  } catch (err) {
    cleanupPartial();
    throw err;
  }

  return {
    source,
    isBitmap,
    overview,
    overviewScale: ov.overviewScale,
    naturalW,
    naturalH,
    objectUrl: retainedUrl,
  };
}

function easeOutCubic(t: number): number {
  return 1 - (1 - t) ** 3;
}

/**
 * Full-screen high-res map viewer (#38).
 * Dual-layer `<canvas>` (<=2048px overview during active interaction + visible-region HD
 * slice draw when settled past overview scale) inside a modal `<dialog>`. Display canvas
 * stays sized to viewport * min(dpr, 2) so >4000px maps never blank on iOS Safari.
 */
export function MapViewer({
  map,
  online,
  isSaved,
  openMap,
  cancelDownload,
  saveProgress = null,
  onSave,
  onViewportChange,
  onClose,
  children,
}: MapViewerProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const topBarRef = useRef<HTMLElement>(null);
  const bottomBarRef = useRef<HTMLDivElement>(null);
  const closeBtnRef = useRef<HTMLButtonElement>(null);
  const invokerRef = useRef<HTMLElement | null>(null);

  const [viewerState, setViewerState] = useState<ViewerState>({
    kind: "loading",
    big: false,
    phase: "downloading",
    progress: null,
  });
  const [pixelCrisp, setPixelCrisp] = useState<boolean>(() => readSessionPixelCrisp());
  const [isDragging, setIsDragging] = useState(false);
  const [zoomUi, setZoomUi] = useState({ percent: 100, atMin: true, atMax: false });
  const [retryToken, setRetryToken] = useState(0);

  // Hot mutable refs keep gesture & rAF rendering off React state (zero per-frame churn).
  const assetRef = useRef<DecodedAsset | null>(null);
  const transformRef = useRef<Transform>({ scale: 1, offset: { x: 0, y: 0 } });
  const viewportRef = useRef({ width: 1, height: 1, dpr: 1 });
  const insetsRef = useRef<BarInsets>({ top: 48, bottom: 48, left: 0, right: 0 });
  const pixelCrispRef = useRef(pixelCrisp);
  const interactingRef = useRef(false);
  const hdPendingRef = useRef(false);
  const pointersRef = useRef<Map<number, PointerRecord>>(new Map());
  const rawDragOffsetRef = useRef<{ x: number; y: number } | null>(null);
  const hadMultiTouchRef = useRef(false);
  const lastTapRef = useRef<{ time: number; x: number; y: number } | null>(null);
  const suppressDblClickUntilRef = useRef(0);

  const rafRef = useRef<number | null>(null);
  const animRafRef = useRef<number | null>(null);
  const hdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wheelTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const loadGenRef = useRef(0);

  // Keep latest callbacks/props readable from imperative event handlers without re-binding.
  const mapRef = useRef(map);
  const isSavedRef = useRef(isSaved);
  const onViewportChangeRef = useRef(onViewportChange);
  const onCloseRef = useRef(onClose);
  const openMapRef = useRef(openMap);
  const cancelDownloadRef = useRef(cancelDownload);

  useEffect(() => {
    mapRef.current = map;
  }, [map]);
  useEffect(() => {
    isSavedRef.current = isSaved;
  }, [isSaved]);
  useEffect(() => {
    onViewportChangeRef.current = onViewportChange;
  }, [onViewportChange]);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);
  useEffect(() => {
    openMapRef.current = openMap;
  }, [openMap]);
  useEffect(() => {
    cancelDownloadRef.current = cancelDownload;
  }, [cancelDownload]);
  useEffect(() => {
    pixelCrispRef.current = pixelCrisp;
  }, [pixelCrisp]);

  const getVisibleBox = useCallback(() => {
    const vp = viewportRef.current;
    const ins = insetsRef.current;
    return {
      visibleW: Math.max(1, vp.width - ins.left - ins.right),
      visibleH: Math.max(1, vp.height - ins.top - ins.bottom),
      insetLeft: ins.left,
      insetTop: ins.top,
    };
  }, []);

  const getMaxZoom = useCallback(() => {
    const asset = assetRef.current;
    if (!asset) return 4;
    const { visibleW, visibleH } = getVisibleBox();
    return calculateMapMaxZoom(asset.naturalW, asset.naturalH, visibleW, visibleH);
  }, [getVisibleBox]);

  const syncZoomUi = useCallback(() => {
    const asset = assetRef.current;
    if (!asset) return;
    const { visibleW, visibleH } = getVisibleBox();
    const fit = calculateFitScale(asset.naturalW, asset.naturalH, visibleW, visibleH);
    const maxZoom = calculateMapMaxZoom(asset.naturalW, asset.naturalH, visibleW, visibleH);
    const { scale } = transformRef.current;
    const next = {
      percent: formatZoomPercent(fit, scale),
      atMin: scale <= 1.001,
      atMax: scale >= maxZoom - 0.001,
    };
    setZoomUi((prev) =>
      prev.percent === next.percent && prev.atMin === next.atMin && prev.atMax === next.atMax ? prev : next,
    );
  }, [getVisibleBox]);

  const persistViewport = useCallback(() => {
    const currentMap = mapRef.current;
    if (!currentMap || !assetRef.current) return;
    const { scale, offset } = transformRef.current;
    const state = {
      lastZoom: scale,
      lastOffsetX: Math.round(offset.x * 100) / 100,
      lastOffsetY: Math.round(offset.y * 100) / 100,
    };
    if (isSavedRef.current && currentMap.savedId && onViewportChangeRef.current) {
      onViewportChangeRef.current(currentMap.savedId, state);
    } else {
      sessionViewports.set(currentMap.imageUrl, state);
    }
  }, []);

  const renderNow = useCallback(
    (allowHd: boolean) => {
      const canvas = canvasRef.current;
      const asset = assetRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const { width: canvasW, height: canvasH, dpr } = viewportRef.current;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = CANVAS_BG;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      if (!asset) return;

      const { visibleW, visibleH, insetLeft, insetTop } = getVisibleBox();
      const { scale, offset } = transformRef.current;
      const fit = calculateFitScale(asset.naturalW, asset.naturalH, visibleW, visibleH);
      const totalScale = fit * scale;
      const rect = computeCanvasDrawRect({
        naturalW: asset.naturalW,
        naturalH: asset.naturalH,
        canvasW,
        canvasH,
        visibleW,
        visibleH,
        insetLeft,
        insetTop,
        scale,
        offset,
      });
      if (rect.sw < 0.01 || rect.sh < 0.01 || rect.dw < 0.5 || rect.dh < 0.5) return;

      const useHd = allowHd && !interactingRef.current && shouldRenderHdOverlay(totalScale, asset.overviewScale);
      ctx.imageSmoothingEnabled = !pixelCrispRef.current;
      if (!pixelCrispRef.current) ctx.imageSmoothingQuality = useHd ? "high" : "medium";

      const dx = rect.dx * dpr;
      const dy = rect.dy * dpr;
      const dw = rect.dw * dpr;
      const dh = rect.dh * dpr;

      if (useHd) {
        const sx = Math.max(0, Math.min(asset.naturalW - 0.01, rect.sx));
        const sy = Math.max(0, Math.min(asset.naturalH - 0.01, rect.sy));
        const sw = Math.max(0.01, Math.min(asset.naturalW - sx, rect.sw));
        const sh = Math.max(0.01, Math.min(asset.naturalH - sy, rect.sh));
        ctx.drawImage(asset.source, sx, sy, sw, sh, dx, dy, dw, dh);
      } else {
        const ovW = asset.overview.width;
        const ovH = asset.overview.height;
        const sx = Math.max(0, Math.min(ovW - 0.01, rect.sx * asset.overviewScale));
        const sy = Math.max(0, Math.min(ovH - 0.01, rect.sy * asset.overviewScale));
        const sw = Math.max(0.01, Math.min(ovW - sx, rect.sw * asset.overviewScale));
        const sh = Math.max(0.01, Math.min(ovH - sy, rect.sh * asset.overviewScale));
        ctx.drawImage(asset.overview, sx, sy, sw, sh, dx, dy, dw, dh);
      }
    },
    [getVisibleBox],
  );

  const scheduleDraw = useCallback(
    (allowHd = false) => {
      if (allowHd) hdPendingRef.current = true;
      if (rafRef.current !== null) return;
      rafRef.current = window.requestAnimationFrame(() => {
        rafRef.current = null;
        const hd = hdPendingRef.current;
        hdPendingRef.current = false;
        renderNow(hd);
      });
    },
    [renderNow],
  );

  const scheduleHdSettle = useCallback(() => {
    if (hdTimerRef.current) clearTimeout(hdTimerRef.current);
    hdTimerRef.current = setTimeout(() => {
      hdTimerRef.current = null;
      if (!interactingRef.current) scheduleDraw(true);
    }, HD_SETTLE_DELAY_MS);
  }, [scheduleDraw]);

  const cancelAnimation = useCallback(() => {
    if (animRafRef.current !== null) {
      window.cancelAnimationFrame(animRafRef.current);
      animRafRef.current = null;
    }
  }, []);

  const animateToTransform = useCallback(
    (target: Transform, { animate, persist = true }: { animate: boolean; persist?: boolean }) => {
      cancelAnimation();
      const shouldAnimate = animate && !prefersReducedMotion();
      if (!shouldAnimate) {
        interactingRef.current = false;
        transformRef.current = target;
        scheduleDraw(true);
        syncZoomUi();
        if (persist) persistViewport();
        return;
      }

      const start: Transform = {
        scale: transformRef.current.scale,
        offset: { ...transformRef.current.offset },
      };
      const startedAt = performance.now();
      interactingRef.current = true;

      const step = (now: number) => {
        const progress = Math.min(1, (now - startedAt) / ZOOM_ANIM_MS);
        const eased = easeOutCubic(progress);
        transformRef.current = {
          scale: start.scale + (target.scale - start.scale) * eased,
          offset: {
            x: start.offset.x + (target.offset.x - start.offset.x) * eased,
            y: start.offset.y + (target.offset.y - start.offset.y) * eased,
          },
        };
        if (progress < 1) {
          renderNow(false);
          animRafRef.current = window.requestAnimationFrame(step);
        } else {
          animRafRef.current = null;
          interactingRef.current = false;
          transformRef.current = target;
          renderNow(true);
          syncZoomUi();
          if (persist) persistViewport();
        }
      };
      animRafRef.current = window.requestAnimationFrame(step);
    },
    [cancelAnimation, persistViewport, renderNow, scheduleDraw, syncZoomUi],
  );

  const measureLayout = useCallback(() => {
    const dialog = dialogRef.current;
    const canvas = canvasRef.current;
    if (!dialog || !canvas) return;
    const dialogRect = dialog.getBoundingClientRect();
    const width = Math.max(1, Math.round(dialogRect.width || window.innerWidth));
    const height = Math.max(1, Math.round(dialogRect.height || window.innerHeight));
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    viewportRef.current = { width, height, dpr };
    const backingW = Math.max(1, Math.round(width * dpr));
    const backingH = Math.max(1, Math.round(height * dpr));
    if (canvas.width !== backingW || canvas.height !== backingH) {
      canvas.width = backingW;
      canvas.height = backingH;
    }

    const topRect = topBarRef.current?.getBoundingClientRect();
    const bottomRect = bottomBarRef.current?.getBoundingClientRect();
    insetsRef.current = {
      top: topRect ? Math.max(0, Math.round(topRect.bottom - dialogRect.top)) : 48,
      bottom: bottomRect ? Math.max(0, Math.round(dialogRect.bottom - bottomRect.top)) : 48,
      left: 0,
      right: 0,
    };

    const asset = assetRef.current;
    if (asset) {
      const { visibleW, visibleH } = getVisibleBox();
      const maxZoom = calculateMapMaxZoom(asset.naturalW, asset.naturalH, visibleW, visibleH);
      const clampedScale = Math.min(maxZoom, Math.max(1, transformRef.current.scale));
      const bounds = calculateMapPanBounds(asset.naturalW, asset.naturalH, visibleW, visibleH, clampedScale);
      transformRef.current = {
        scale: clampedScale,
        offset: clampMapOffset(transformRef.current.offset, bounds),
      };
      scheduleDraw(true);
      syncZoomUi();
    }
  }, [getVisibleBox, scheduleDraw, syncZoomUi]);

  // Modal lifecycle + focus return to invoking element + GPU canvas release on close.
  const isOpen = map !== null;
  useEffect(() => {
    const dialog = dialogRef.current;
    const canvas = canvasRef.current;
    if (!dialog) return;
    if (isOpen) {
      invokerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      if (!dialog.open) dialog.showModal();
      closeBtnRef.current?.focus();
      measureLayout();
    } else if (dialog.open) {
      dialog.close();
    }
    return () => {
      if (!isOpen) return;
      if (dialog.open) dialog.close();
      if (canvas) {
        canvas.width = 0;
        canvas.height = 0;
      }
      const invoker = invokerRef.current;
      invokerRef.current = null;
      if (invoker && invoker.isConnected) {
        invoker.focus();
      }
    };
  }, [isOpen, measureLayout]);

  // Track viewport / bar size changes while open.
  useEffect(() => {
    if (!isOpen) return;
    measureLayout();
    const onResize = () => measureLayout();
    window.addEventListener("resize", onResize);
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(onResize) : null;
    if (observer) {
      if (dialogRef.current) observer.observe(dialogRef.current);
      if (topBarRef.current) observer.observe(topBarRef.current);
      if (bottomBarRef.current) observer.observe(bottomBarRef.current);
    }
    return () => {
      window.removeEventListener("resize", onResize);
      observer?.disconnect();
    };
  }, [isOpen, measureLayout]);

  // Redraw immediately when Pixel Crisp toggles.
  useEffect(() => {
    if (assetRef.current) scheduleDraw(true);
  }, [pixelCrisp, scheduleDraw]);

  // Clear timers/assets on unmount (canvas backing store is released in the [isOpen] cleanup).
  useEffect(() => {
    return () => {
      cancelAnimation();
      if (rafRef.current !== null) window.cancelAnimationFrame(rafRef.current);
      if (hdTimerRef.current) clearTimeout(hdTimerRef.current);
      if (wheelTimerRef.current) clearTimeout(wheelTimerRef.current);
      abortRef.current?.abort();
      disposeAsset(assetRef.current);
      assetRef.current = null;
    };
  }, [cancelAnimation]);

  // Load & decode map whenever the active map URL changes or user clicks Try again.
  const mapImageUrl = map?.imageUrl ?? null;
  const mapSourceUrl = map?.sourceUrl ?? null;

  useEffect(() => {
    const currentMap = mapRef.current;
    const gen = ++loadGenRef.current;

    cancelAnimation();
    if (hdTimerRef.current) {
      clearTimeout(hdTimerRef.current);
      hdTimerRef.current = null;
    }
    if (wheelTimerRef.current) {
      clearTimeout(wheelTimerRef.current);
      wheelTimerRef.current = null;
    }
    pointersRef.current.clear();
    rawDragOffsetRef.current = null;
    hadMultiTouchRef.current = false;
    interactingRef.current = false;
    setIsDragging(false);

    abortRef.current?.abort();
    abortRef.current = null;
    disposeAsset(assetRef.current);
    assetRef.current = null;

    if (!mapImageUrl || !mapSourceUrl || !currentMap) {
      if (canvasRef.current) {
        canvasRef.current.width = 0;
        canvasRef.current.height = 0;
      }
      return;
    }

    // Clear previous map pixels immediately before showing the next map's loading/status overlay.
    renderNow(false);

    if (currentMap.overLimit) {
      setViewerState({ kind: "too_large" });
      return;
    }

    const controller = new AbortController();
    abortRef.current = controller;
    let active = true;
    let openedUrl: string | null = null;
    let decoding = false;
    let isBig = false;
    let latestProgress: MapDownloadProgress | null = null;
    let lastEmitAt = 0;
    let lastProgressKey = "";

    setViewerState({ kind: "loading", big: false, phase: "downloading", progress: null });
    const bigTimer = setTimeout(() => {
      if (!active || loadGenRef.current !== gen) return;
      isBig = true;
      lastEmitAt = performance.now();
      setViewerState((prev) =>
        prev.kind === "loading" ? { ...prev, big: true, progress: prev.phase === "downloading" ? latestProgress : null } : prev,
      );
    }, BIG_LOAD_DELAY_MS);

    const run = async () => {
      try {
        const res = await openMapRef.current(
          { imageUrl: mapImageUrl, sourceUrl: mapSourceUrl },
          controller.signal,
          (progress) => {
            if (!active || loadGenRef.current !== gen) return;
            latestProgress = progress;
            if (!isBig) return;
            const key = progress.total
              ? `${formatMegabytes(progress.loaded)}/${formatMegabytes(progress.total)}`
              : formatMegabytes(progress.loaded);
            const now = performance.now();
            const isComplete = progress.total !== null && progress.loaded >= progress.total;
            if (!isComplete && (key === lastProgressKey || now - lastEmitAt < 120)) return;
            lastEmitAt = now;
            lastProgressKey = key;
            setViewerState((prev) =>
              prev.kind === "loading" && prev.phase === "downloading" ? { ...prev, progress } : prev,
            );
          },
        );

        if (!active || loadGenRef.current !== gen) {
          if (res.status === "ok") URL.revokeObjectURL(res.objectUrl);
          return;
        }

        if (res.status !== "ok") {
          clearTimeout(bigTimer);
          if (res.status === "aborted") return;
          if (res.status === "offline") setViewerState({ kind: "offline" });
          else if (res.status === "too_large") setViewerState({ kind: "too_large" });
          else if (res.status === "unlisted") setViewerState({ kind: "unlisted" });
          else setViewerState({ kind: "failed" });
          return;
        }

        openedUrl = res.objectUrl;
        if (res.blob.size > MAX_MAP_BLOB_BYTES) {
          URL.revokeObjectURL(openedUrl);
          openedUrl = null;
          clearTimeout(bigTimer);
          setViewerState({ kind: "too_large" });
          return;
        }

        setViewerState((prev) =>
          prev.kind === "loading" ? { ...prev, phase: "preparing", progress: null } : prev,
        );

        decoding = true;
        const asset = await decodeMapAsset(res.blob, openedUrl);
        openedUrl = null; // Asset owns or already revoked it.

        if (!active || loadGenRef.current !== gen) {
          disposeAsset(asset);
          return;
        }

        clearTimeout(bigTimer);
        assetRef.current = asset;
        measureLayout();

        const { visibleW, visibleH } = getVisibleBox();
        const maxZoom = calculateMapMaxZoom(asset.naturalW, asset.naturalH, visibleW, visibleH);
        const latestMap = mapRef.current;
        const restored =
          latestMap && isSavedRef.current
            ? latestMap
            : latestMap
              ? sessionViewports.get(latestMap.imageUrl)
              : undefined;
        if (restored) {
          transformRef.current = clampRestoredViewport({
            lastZoom: restored.lastZoom,
            lastOffsetX: restored.lastOffsetX,
            lastOffsetY: restored.lastOffsetY,
            naturalW: asset.naturalW,
            naturalH: asset.naturalH,
            visibleW,
            visibleH,
            maxZoom,
          });
        } else {
          transformRef.current = { scale: 1, offset: { x: 0, y: 0 } };
        }

        setViewerState({ kind: "ready", naturalW: asset.naturalW, naturalH: asset.naturalH });
        renderNow(true);
        syncZoomUi();
      } catch (err) {
        clearTimeout(bigTimer);
        if (openedUrl) {
          URL.revokeObjectURL(openedUrl);
          openedUrl = null;
        }
        if (!active || loadGenRef.current !== gen) return;
        if ((err as { name?: string })?.name === "AbortError") return;
        setViewerState({ kind: decoding || looksLikeMemoryDecodeError(err) ? "decode_failed" : "failed" });
      }
    };

    void run();

    return () => {
      active = false;
      clearTimeout(bigTimer);
      controller.abort();
      if (abortRef.current === controller) abortRef.current = null;
      if (openedUrl) {
        URL.revokeObjectURL(openedUrl);
        openedUrl = null;
      }
    };
  }, [mapImageUrl, mapSourceUrl, retryToken, cancelAnimation, getVisibleBox, measureLayout, renderNow, syncZoomUi]);

  // Zoom / pan action helpers shared by buttons, double-tap, and keyboard.
  const applyZoomToCenter = useCallback(
    (nextScale: number, { animate }: { animate: boolean }) => {
      const asset = assetRef.current;
      if (!asset) return;
      const { visibleW, visibleH } = getVisibleBox();
      const maxZoom = calculateMapMaxZoom(asset.naturalW, asset.naturalH, visibleW, visibleH);
      const current = transformRef.current;
      const zoomFactor = nextScale / current.scale;
      const target = computeFocalZoomTransform({
        scale: current.scale,
        offset: current.offset,
        zoomFactor,
        centroid: { x: visibleW / 2, y: visibleH / 2 },
        viewportW: visibleW,
        viewportH: visibleH,
        naturalW: asset.naturalW,
        naturalH: asset.naturalH,
        maxZoom,
      });
      animateToTransform(target, { animate });
    },
    [animateToTransform, getVisibleBox],
  );

  const zoomIn = useCallback(
    (animate: boolean) => {
      const maxZoom = getMaxZoom();
      applyZoomToCenter(Math.min(maxZoom, transformRef.current.scale * BUTTON_ZOOM_STEP), { animate });
    },
    [applyZoomToCenter, getMaxZoom],
  );

  const zoomOut = useCallback(
    (animate: boolean) => {
      applyZoomToCenter(Math.max(1, transformRef.current.scale / BUTTON_ZOOM_STEP), { animate });
    },
    [applyZoomToCenter],
  );

  const zoomFit = useCallback(
    (animate: boolean) => {
      if (!assetRef.current) return;
      animateToTransform({ scale: 1, offset: { x: 0, y: 0 } }, { animate });
    },
    [animateToTransform],
  );

  const zoomActual = useCallback(
    (animate: boolean) => {
      const asset = assetRef.current;
      if (!asset) return;
      const { visibleW, visibleH } = getVisibleBox();
      const maxZoom = calculateMapMaxZoom(asset.naturalW, asset.naturalH, visibleW, visibleH);
      const targetScale = actualSizeScale(asset.naturalW, asset.naturalH, visibleW, visibleH, maxZoom);
      applyZoomToCenter(targetScale, { animate });
    },
    [applyZoomToCenter, getVisibleBox],
  );

  const toggleFitActualAt = useCallback(
    (clientX: number, clientY: number, animate: boolean) => {
      const asset = assetRef.current;
      const canvas = canvasRef.current;
      if (!asset || !canvas) return;
      const rect = canvas.getBoundingClientRect();
      const { visibleW, visibleH, insetLeft, insetTop } = getVisibleBox();
      const maxZoom = calculateMapMaxZoom(asset.naturalW, asset.naturalH, visibleW, visibleH);
      const current = transformRef.current;
      const targetScale = doubleTapTargetScale(
        current.scale,
        asset.naturalW,
        asset.naturalH,
        visibleW,
        visibleH,
        maxZoom,
      );
      if (targetScale <= 1.001) {
        animateToTransform({ scale: 1, offset: { x: 0, y: 0 } }, { animate });
        return;
      }
      const target = computeFocalZoomTransform({
        scale: current.scale,
        offset: current.offset,
        zoomFactor: targetScale / current.scale,
        centroid: {
          x: clientX - rect.left - insetLeft,
          y: clientY - rect.top - insetTop,
        },
        viewportW: visibleW,
        viewportH: visibleH,
        naturalW: asset.naturalW,
        naturalH: asset.naturalH,
        maxZoom,
      });
      animateToTransform(target, { animate });
    },
    [animateToTransform, getVisibleBox],
  );

  const panBy = useCallback(
    (dx: number, dy: number) => {
      const asset = assetRef.current;
      if (!asset) return;
      cancelAnimation();
      const { visibleW, visibleH } = getVisibleBox();
      const current = transformRef.current;
      const bounds = calculateMapPanBounds(asset.naturalW, asset.naturalH, visibleW, visibleH, current.scale);
      transformRef.current = {
        scale: current.scale,
        offset: clampMapOffset({ x: current.offset.x + dx, y: current.offset.y + dy }, bounds),
      };
      interactingRef.current = false;
      scheduleDraw(true);
      persistViewport();
    },
    [cancelAnimation, getVisibleBox, persistViewport, scheduleDraw],
  );

  const togglePixelCrisp = useCallback(() => {
    setPixelCrisp((prev) => {
      const next = !prev;
      writeSessionPixelCrisp(next);
      return next;
    });
  }, []);

  const handleClose = useCallback(() => {
    abortRef.current?.abort();
    onCloseRef.current();
  }, []);

  const handleCancelBigLoad = useCallback(() => {
    abortRef.current?.abort();
    const currentMap = mapRef.current;
    if (currentMap) {
      cancelDownloadRef.current?.({ imageUrl: currentMap.imageUrl, sourceUrl: currentMap.sourceUrl });
    }
    onCloseRef.current();
  }, []);

  // Right after a save lands, keep the current pan/zoom on the new saved record.
  const savedId = map?.savedId ?? null;
  useEffect(() => {
    if (savedId && isSaved && assetRef.current) persistViewport();
  }, [savedId, isSaved, persistViewport]);

  // Wheel / trackpad pinch zoom (non-passive so scrolling is prevented).
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!isOpen || !canvas) return;
    const onWheel = (e: WheelEvent) => {
      if (!assetRef.current) return;
      e.preventDefault();
      cancelAnimation();
      const asset = assetRef.current;
      const rect = canvas.getBoundingClientRect();
      const { visibleW, visibleH, insetLeft, insetTop } = getVisibleBox();
      const maxZoom = calculateMapMaxZoom(asset.naturalW, asset.naturalH, visibleW, visibleH);
      const current = transformRef.current;
      const factor = wheelZoomFactor(e.deltaY, e.deltaMode, e.ctrlKey);
      if (factor === 1) return;

      interactingRef.current = true;
      transformRef.current = computeFocalZoomTransform({
        scale: current.scale,
        offset: current.offset,
        zoomFactor: factor,
        centroid: {
          x: e.clientX - rect.left - insetLeft,
          y: e.clientY - rect.top - insetTop,
        },
        viewportW: visibleW,
        viewportH: visibleH,
        naturalW: asset.naturalW,
        naturalH: asset.naturalH,
        maxZoom,
      });
      scheduleDraw(false);

      if (wheelTimerRef.current) clearTimeout(wheelTimerRef.current);
      wheelTimerRef.current = setTimeout(() => {
        wheelTimerRef.current = null;
        interactingRef.current = false;
        scheduleDraw(true);
        syncZoomUi();
        persistViewport();
      }, WHEEL_SETTLE_DELAY_MS);
    };

    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  }, [isOpen, cancelAnimation, getVisibleBox, persistViewport, scheduleDraw, syncZoomUi]);

  // Keyboard shortcuts (direct, no animation; disabled while focus is in an input).
  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (isEditableTarget(e.target)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      if (e.key === "Escape") {
        e.preventDefault();
        handleClose();
        return;
      }
      if (!assetRef.current) return;

      const { visibleW, visibleH } = getVisibleBox();
      const stepRatio = e.shiftKey ? 0.5 : 0.15;

      switch (e.key) {
        case "+":
        case "=":
          e.preventDefault();
          zoomIn(false);
          break;
        case "-":
        case "_":
          e.preventDefault();
          zoomOut(false);
          break;
        case "0":
        case "Home":
          e.preventDefault();
          zoomFit(false);
          break;
        case "1":
          e.preventDefault();
          zoomActual(false);
          break;
        case "p":
        case "P":
          e.preventDefault();
          togglePixelCrisp();
          break;
        case "ArrowLeft":
          e.preventDefault();
          panBy(visibleW * stepRatio, 0);
          break;
        case "ArrowRight":
          e.preventDefault();
          panBy(-visibleW * stepRatio, 0);
          break;
        case "ArrowUp":
          e.preventDefault();
          panBy(0, visibleH * stepRatio);
          break;
        case "ArrowDown":
          e.preventDefault();
          panBy(0, -visibleH * stepRatio);
          break;
        default:
          break;
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isOpen, getVisibleBox, handleClose, panBy, togglePixelCrisp, zoomActual, zoomFit, zoomIn, zoomOut]);

  // Pointer Events: 1-pointer bounded pan (with <=24px overscroll) + 2-pointer focal pinch.
  const onPointerDown = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!assetRef.current) return;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    const pointers = pointersRef.current;
    // Ignore 3rd+ pointers during an active pinch.
    if (pointers.size >= 2 && !pointers.has(e.pointerId)) return;

    cancelAnimation();
    e.currentTarget.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, {
      x: e.clientX,
      y: e.clientY,
      startX: e.clientX,
      startY: e.clientY,
      pointerType: e.pointerType,
    });
    if (pointers.size >= 2) {
      hadMultiTouchRef.current = true;
      rawDragOffsetRef.current = null;
    } else {
      rawDragOffsetRef.current = { ...transformRef.current.offset };
    }
    interactingRef.current = true;
    setIsDragging(true);
    if (hdTimerRef.current) {
      clearTimeout(hdTimerRef.current);
      hdTimerRef.current = null;
    }
    if (wheelTimerRef.current) {
      clearTimeout(wheelTimerRef.current);
      wheelTimerRef.current = null;
    }
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const asset = assetRef.current;
    const pointers = pointersRef.current;
    const prev = pointers.get(e.pointerId);
    if (!asset || !prev) return;

    const { visibleW, visibleH, insetLeft, insetTop } = getVisibleBox();
    const current = transformRef.current;

    if (pointers.size === 1) {
      const dx = e.clientX - prev.x;
      const dy = e.clientY - prev.y;
      prev.x = e.clientX;
      prev.y = e.clientY;
      const bounds = calculateMapPanBounds(asset.naturalW, asset.naturalH, visibleW, visibleH, current.scale);
      const reduced = prefersReducedMotion();
      const prevRaw = rawDragOffsetRef.current ?? current.offset;
      const rawX = prevRaw.x + dx;
      const rawY = prevRaw.y + dy;
      const nextRaw = reduced
        ? {
            x: Math.min(bounds.maxPanX, Math.max(-bounds.maxPanX, rawX)),
            y: Math.min(bounds.maxPanY, Math.max(-bounds.maxPanY, rawY)),
          }
        : { x: rawX, y: rawY };
      rawDragOffsetRef.current = nextRaw;
      transformRef.current = {
        scale: current.scale,
        offset: {
          x: applyOverscrollResistance(nextRaw.x, bounds.maxPanX, MAX_OVERSCROLL_PX, reduced),
          y: applyOverscrollResistance(nextRaw.y, bounds.maxPanY, MAX_OVERSCROLL_PX, reduced),
        },
      };
      scheduleDraw(false);
      return;
    }

    if (pointers.size === 2) {
      const entries = Array.from(pointers.entries());
      const [idA, pA] = entries[0];
      const [, pB] = entries[1];
      const prevDist = Math.hypot(pB.x - pA.x, pB.y - pA.y);
      const prevCx = (pA.x + pB.x) / 2;
      const prevCy = (pA.y + pB.y) / 2;

      prev.x = e.clientX;
      prev.y = e.clientY;
      const nextA = idA === e.pointerId ? prev : pA;
      const nextB = idA === e.pointerId ? pB : prev;
      const nextDist = Math.hypot(nextB.x - nextA.x, nextB.y - nextA.y);
      const nextCx = (nextA.x + nextB.x) / 2;
      const nextCy = (nextA.y + nextB.y) / 2;

      if (prevDist > 1 && nextDist > 1) {
        const rect = e.currentTarget.getBoundingClientRect();
        const maxZoom = calculateMapMaxZoom(asset.naturalW, asset.naturalH, visibleW, visibleH);
        transformRef.current = computeFocalZoomTransform({
          scale: current.scale,
          offset: current.offset,
          zoomFactor: nextDist / prevDist,
          panDelta: { x: nextCx - prevCx, y: nextCy - prevCy },
          centroid: {
            x: nextCx - rect.left - insetLeft,
            y: nextCy - rect.top - insetTop,
          },
          viewportW: visibleW,
          viewportH: visibleH,
          naturalW: asset.naturalW,
          naturalH: asset.naturalH,
          maxZoom,
        });
        scheduleDraw(false);
      }
    }
  };

  const finishPointer = (e: ReactPointerEvent<HTMLCanvasElement>, cancelled: boolean) => {
    const pointers = pointersRef.current;
    const ended = pointers.get(e.pointerId);
    if (!ended) return;
    pointers.delete(e.pointerId);
    if (e.currentTarget.hasPointerCapture?.(e.pointerId)) {
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        // Ignore if already released.
      }
    }

    if (pointers.size > 0) {
      if (pointers.size === 1) {
        rawDragOffsetRef.current = { ...transformRef.current.offset };
      }
      return;
    }

    const wasMultiTouch = hadMultiTouchRef.current;
    hadMultiTouchRef.current = false;
    rawDragOffsetRef.current = null;
    interactingRef.current = false;
    setIsDragging(false);

    const asset = assetRef.current;
    if (!asset) return;

    // Touch double-tap detection (mouse uses onDoubleClick; skip after a 2-finger pinch).
    if (!cancelled && !wasMultiTouch && ended.pointerType !== "mouse") {
      const moved = Math.hypot(e.clientX - ended.startX, e.clientY - ended.startY);
      if (moved <= TAP_MAX_DRAG) {
        const now = performance.now();
        const prevTap = lastTapRef.current;
        if (
          prevTap &&
          now - prevTap.time <= DOUBLE_TAP_WINDOW_MS &&
          Math.hypot(e.clientX - prevTap.x, e.clientY - prevTap.y) <= DOUBLE_TAP_MAX_DIST
        ) {
          lastTapRef.current = null;
          suppressDblClickUntilRef.current = now + 400;
          toggleFitActualAt(e.clientX, e.clientY, true);
          return;
        }
        lastTapRef.current = { time: now, x: e.clientX, y: e.clientY };
      } else {
        lastTapRef.current = null;
      }
    } else if (wasMultiTouch) {
      lastTapRef.current = null;
    }

    // Ease back from any overscroll past pan bounds (instant under reduced motion).
    const { visibleW, visibleH } = getVisibleBox();
    const current = transformRef.current;
    const bounds = calculateMapPanBounds(asset.naturalW, asset.naturalH, visibleW, visibleH, current.scale);
    const clamped = clampMapOffset(current.offset, bounds);
    if (Math.abs(clamped.x - current.offset.x) > 0.5 || Math.abs(clamped.y - current.offset.y) > 0.5) {
      animateToTransform({ scale: current.scale, offset: clamped }, { animate: true });
      return;
    }

    syncZoomUi();
    persistViewport();
    scheduleHdSettle();
  };

  const onDoubleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!assetRef.current) return;
    if (performance.now() < suppressDblClickUntilRef.current) return;
    toggleFitActualAt(e.clientX, e.clientY, true);
  };

  if (!map) return null;

  const isReady = viewerState.kind === "ready";
  const metaDimensions =
    viewerState.kind === "ready"
      ? formatDimensionsLabel(viewerState.naturalW, viewerState.naturalH)
      : formatDimensionsLabel(map.width, map.height, map.dimensions);
  const metaLine = [metaDimensions, isReady ? `${zoomUi.percent}%` : ""].filter(Boolean).join(" · ");

  const loadPercent =
    viewerState.kind === "loading" &&
    viewerState.progress &&
    viewerState.progress.total &&
    viewerState.progress.total > 0
      ? Math.min(100, Math.round((viewerState.progress.loaded / viewerState.progress.total) * 100))
      : null;

  const backButton = (
    <button type="button" className="map-viewer-status-btn" onClick={handleClose}>
      ‹ Maps
    </button>
  );

  let saveSlot: ReactNode = null;
  if (isSaved) {
    saveSlot = <span className="map-viewer-saved">Saved</span>;
  } else if (saveProgress) {
    saveSlot = (
      <span className="map-viewer-saved" role="status">
        {formatSavingText(saveProgress)}
      </span>
    );
  } else if (viewerState.kind === "too_large") {
    saveSlot = <span className="map-viewer-save-reason">Over 30 MB</span>;
  } else if (online && onSave && (viewerState.kind === "ready" || viewerState.kind === "loading")) {
    saveSlot = (
      <button type="button" className="map-viewer-save" onClick={onSave}>
        <span className="map-viewer-save-long">Save offline</span>
        <span className="map-viewer-save-short" aria-hidden="true">
          Save
        </span>
      </button>
    );
  }

  return (
    <dialog
      ref={dialogRef}
      className="map-viewer-dialog"
      aria-label="Map viewer"
      onCancel={(e) => {
        e.preventDefault();
        handleClose();
      }}
    >
      <canvas
        ref={canvasRef}
        className={`map-viewer-canvas${isDragging ? " is-dragging" : ""}`}
        tabIndex={0}
        aria-label={`Map: ${map.title}. Arrow keys pan, plus and minus zoom.`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={(e) => finishPointer(e, false)}
        onPointerCancel={(e) => finishPointer(e, true)}
        onDoubleClick={onDoubleClick}
      />

      <header ref={topBarRef} className="map-viewer-top">
        <button
          ref={closeBtnRef}
          type="button"
          className="map-viewer-close"
          onClick={handleClose}
          aria-label="Back to maps"
        >
          ‹ Maps
        </button>

        <div className="map-viewer-title-block">
          <div className="map-viewer-title">{map.title}</div>
          {metaLine && (
            <div className="map-viewer-meta" aria-live="polite">
              {metaLine}
            </div>
          )}
        </div>

        <div className="map-viewer-save-slot">{saveSlot}</div>
      </header>

      {viewerState.kind === "loading" && (
        <div className="map-viewer-status" aria-live="polite">
          {!viewerState.big ? (
            <p className="map-viewer-status-text">Loading map…</p>
          ) : viewerState.phase === "preparing" ? (
            <div className="map-viewer-status-block">
              <p className="map-viewer-status-title">{map.title}</p>
              <p className="map-viewer-status-text">Preparing map…</p>
            </div>
          ) : (
            <div className="map-viewer-status-block">
              <p className="map-viewer-status-title">{map.title}</p>
              <p className="map-viewer-status-text">
                {viewerState.progress && viewerState.progress.total
                  ? `Downloading ${formatMegabytes(viewerState.progress.loaded)} / ${formatMegabytes(viewerState.progress.total)} MB`
                  : viewerState.progress && viewerState.progress.loaded > 0
                    ? `Downloading ${formatMegabytes(viewerState.progress.loaded)} MB`
                    : "Downloading map…"}
              </p>
              <div className="map-viewer-progress" aria-hidden="true">
                <div
                  className="map-viewer-progress-fill"
                  style={{ transform: `scaleX(${(loadPercent ?? 25) / 100})` }}
                />
              </div>
              <div className="map-viewer-status-actions">
                <button type="button" className="map-viewer-status-btn" onClick={handleCancelBigLoad}>
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {viewerState.kind !== "loading" && viewerState.kind !== "ready" && (
        <div className="map-viewer-status" role="status">
          <div className="map-viewer-status-block">
            <p className="map-viewer-status-text">
              {viewerState.kind === "offline"
                ? "You're offline and this map isn't saved."
                : viewerState.kind === "too_large"
                  ? "This map is too large to open here (over 30 MB)."
                  : viewerState.kind === "unlisted"
                    ? "This map is no longer on VGMaps."
                    : viewerState.kind === "decode_failed"
                      ? "This device couldn't open this map."
                      : "Couldn't open this map."}
            </p>
            <div className="map-viewer-status-actions">
              {viewerState.kind === "failed" && (
                <button
                  type="button"
                  className="map-viewer-status-btn"
                  onClick={() => setRetryToken((n) => n + 1)}
                >
                  Try again
                </button>
              )}
              {backButton}
            </div>
          </div>
        </div>
      )}

      <div ref={bottomBarRef} className="map-viewer-zoom" role="toolbar" aria-label="Map zoom controls">
        <button
          type="button"
          className="map-viewer-zoom-btn"
          onClick={() => zoomOut(true)}
          disabled={!isReady || zoomUi.atMin}
          aria-label="Zoom out"
        >
          −
        </button>
        <button
          type="button"
          className="map-viewer-zoom-btn"
          onClick={() => zoomIn(true)}
          disabled={!isReady || zoomUi.atMax}
          aria-label="Zoom in"
        >
          +
        </button>
        <button
          type="button"
          className="map-viewer-zoom-btn"
          onClick={() => zoomFit(true)}
          disabled={!isReady}
          aria-label="Fit to screen"
        >
          Fit
        </button>
        <button
          type="button"
          className="map-viewer-zoom-btn"
          onClick={() => zoomActual(true)}
          disabled={!isReady}
          aria-label="Actual size"
        >
          1:1
        </button>
        <button
          type="button"
          className={`map-viewer-zoom-btn map-viewer-pixel${pixelCrisp ? " is-active" : ""}`}
          onClick={togglePixelCrisp}
          aria-pressed={pixelCrisp}
          aria-label={pixelCrisp ? "Pixel crisp, on" : "Pixel crisp, off"}
        >
          Pixel
        </button>
      </div>

      {children}
    </dialog>
  );
}
