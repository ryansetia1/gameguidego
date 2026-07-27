import type { FormEvent, RefObject } from "react";
import type { User } from "@supabase/supabase-js";
import { ClearButton } from "../clear-button";
import { ComposerExtras } from "../composer-extras";
import {
  IconArrowUpRight,
  IconIncognito,
  IconStop,
  IconX,
} from "../icons";
import { VoiceVisualizer } from "../voice-visualizer";
import { GuideSourceStrip } from "./guide-source-strip";
import type { GuideIndexState } from "@/lib/guide-index-state";
import type { GuideMeta } from "../guide-link-field";

export type PendingImage = {
  blob?: Blob;
  preview: string;
  isExisting?: boolean;
};

export type ComposerShellProps = {
  started: boolean;
  temporary: boolean;
  spoilerMajor: boolean;
  inlineEdit: boolean;
  dragActive: boolean;
  composerLocked: boolean;
  guideIndexing: boolean;
  coverEnabled: boolean;
  hasGame: boolean;
  preferredUrlCount: number;
  preferredUrls: string[];
  guideMeta: Record<string, GuideMeta>;
  guideIndexState: GuideIndexState;
  guideSourceSelection: string[] | null;
  onGuideSourceSelectionChange: (selection: string[] | null) => void;
  input: string;
  editingIndex: number | null;
  loading: boolean;
  isExpanded: boolean;
  voiceListening: boolean;
  voiceSupported: boolean;
  maxMessageImages: number;
  pendingImages: PendingImage[];
  user: User | null;
  composerRef: RefObject<HTMLTextAreaElement | null>;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onInputChange: (value: string) => void;
  onDragActiveChange: (active: boolean) => void;
  onSelectImages: (files: FileList | null) => void;
  onRemovePendingImage: (index: number) => void;
  onOpenLightbox: (images: string[], index: number) => void;
  onToggleTemporary: () => void;
  onToggleSpoiler: () => void;
  showGuideRetrievalToggles?: boolean;
  guideRetrievalMode?: "default" | "skip" | "supplement";
  onToggleSkipGuide?: () => void;
  onToggleSupplementGuide?: () => void;
  onVoiceListeningChange: (listening: boolean) => void;
  onVoiceTranscript: (text: string) => void;
  onStopGeneration: () => void;
  onCancelEdit: () => void;
};

export function ComposerShell({
  started,
  temporary,
  spoilerMajor,
  inlineEdit,
  dragActive,
  composerLocked,
  guideIndexing,
  coverEnabled,
  hasGame,
  preferredUrlCount,
  preferredUrls,
  guideMeta,
  guideIndexState,
  guideSourceSelection,
  onGuideSourceSelectionChange,
  input,
  editingIndex,
  loading,
  isExpanded,
  voiceListening,
  voiceSupported,
  maxMessageImages,
  pendingImages,
  user,
  composerRef,
  onSubmit,
  onInputChange,
  onDragActiveChange,
  onSelectImages,
  onRemovePendingImage,
  onOpenLightbox,
  onToggleTemporary,
  onToggleSpoiler,
  showGuideRetrievalToggles,
  guideRetrievalMode,
  onToggleSkipGuide,
  onToggleSupplementGuide,
  onVoiceListeningChange,
  onVoiceTranscript,
  onStopGeneration,
  onCancelEdit,
}: ComposerShellProps) {
  return (
    <form
      className={`composer${started || preferredUrlCount > 0 ? " docked" : ""}${inlineEdit ? " inline-edit" : ""}${temporary ? " temporary" : ""}${spoilerMajor ? " spoilers-on" : ""}${dragActive ? " drag-active" : ""}`}
      onSubmit={onSubmit}
      onDragOver={
        coverEnabled && !composerLocked
          ? (event) => {
              if (!event.dataTransfer.types.includes("Files")) return;
              event.preventDefault();
              onDragActiveChange(true);
            }
          : undefined
      }
      onDragLeave={
        coverEnabled && !composerLocked
          ? (event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                onDragActiveChange(false);
              }
            }
          : undefined
      }
      onDrop={
        coverEnabled && !composerLocked
          ? (event) => {
              if (!event.dataTransfer.types.includes("Files")) return;
              event.preventDefault();
              onDragActiveChange(false);
              void onSelectImages(event.dataTransfer.files);
            }
          : undefined
      }
    >
      {dragActive && (
        <div className="composer-dropzone" aria-hidden="true">
          Drop images to attach
        </div>
      )}
      {coverEnabled && pendingImages.length > 0 && (
        <div className="composer-attachments">
          {pendingImages.map((img, i) => (
            <div key={i} className="attachment-thumb">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={img.preview}
                alt="Attachment preview"
                onClick={() =>
                  onOpenLightbox(
                    pendingImages.map((pending) => pending.preview),
                    i,
                  )
                }
                style={{ cursor: "zoom-in" }}
              />
              <button
                type="button"
                aria-label="Remove image"
                onClick={() => onRemovePendingImage(i)}
                disabled={loading}
              >
                <IconX size={16} />
              </button>
            </div>
          ))}
        </div>
      )}
      <GuideSourceStrip
        preferredUrls={preferredUrls}
        guideMeta={guideMeta}
        guideIndexState={guideIndexState}
        selection={guideSourceSelection}
        onChange={onGuideSourceSelectionChange}
        disabled={composerLocked}
        skipPreferredGuide={guideRetrievalMode === "skip"}
      />
      <div className={`composer-inner ${isExpanded ? "expanded" : ""}`}>
        <div className="composer-input-row">
          <div className="composer-field">
            {!input && !voiceListening && hasGame && !guideIndexing && (
              <div className="composer-placeholder-marquee" aria-hidden="true">
                <div className="marquee-track">
                  <span className="marquee-content">
                    {started ? "Ask a follow-up... " : "Ask for hints, strategy, or next steps... "}
                  </span>
                  <span className="marquee-content">
                    {started ? "Ask a follow-up... " : "Ask for hints, strategy, or next steps... "}
                  </span>
                </div>
              </div>
            )}
            <textarea
              ref={composerRef}
              id="query"
              name="query"
              value={input}
              onChange={(event) => onInputChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                }
              }}
              onPaste={(event) => {
                if (!coverEnabled || composerLocked) return;
                const files = event.clipboardData.files;
                if (
                  files.length > 0 &&
                  Array.from(files).some((file) => file.type.startsWith("image/"))
                ) {
                  event.preventDefault();
                  void onSelectImages(files);
                }
              }}
              placeholder={
                voiceListening
                  ? ""
                  : !hasGame
                    ? "Enter a game name first"
                    : guideIndexing
                      ? "Indexing your guide, one sec…"
                      : ""
              }
              rows={1}
              maxLength={2000}
              required
              disabled={composerLocked}
            />
            <VoiceVisualizer active={voiceListening} />
          </div>
          <ClearButton
            show={input.length > 0 && !loading && editingIndex === null}
            onClear={() => {
              onInputChange("");
              composerRef.current?.focus();
            }}
            disabled={composerLocked}
            label="Clear message"
            className="composer-clear"
          />
        </div>
        <div className="composer-actions">
          {temporary && (
            <button
              type="button"
              className="composer-temp-flag"
              title="Temporary chat on. Tap to turn off."
              aria-label="Temporary chat on. Tap to turn off."
              disabled={loading}
              onClick={() => void onToggleTemporary()}
            >
              <IconIncognito />
            </button>
          )}
          <ComposerExtras
            user={user}
            disabled={composerLocked}
            attachDisabled={pendingImages.length >= maxMessageImages}
            canAttach={coverEnabled}
            voiceSupported={voiceSupported}
            temporary={temporary}
            onToggleTemporary={() => void onToggleTemporary()}
            spoilerMajor={spoilerMajor}
            onToggleSpoiler={() => onToggleSpoiler()}
            showGuideRetrievalToggles={showGuideRetrievalToggles}
            guideRetrievalMode={guideRetrievalMode}
            onToggleSkipGuide={onToggleSkipGuide}
            onToggleSupplementGuide={onToggleSupplementGuide}
            onListeningChange={onVoiceListeningChange}
            onTranscript={onVoiceTranscript}
            onSelectImages={(files) => void onSelectImages(files)}
          />
          {loading ? (
            <button
              className="submit submit-stop"
              type="button"
              onClick={onStopGeneration}
              aria-label="Stop generating"
            >
              <IconStop />
            </button>
          ) : (
            <>
              {editingIndex !== null && (
                <button
                  className="composer-cancel-edit"
                  type="button"
                  onClick={onCancelEdit}
                >
                  Cancel
                </button>
              )}
              <button
                className="submit"
                type="submit"
                disabled={(editingIndex === null && composerLocked) || input.trim().length < 2}
                aria-label={editingIndex !== null ? "Save edit" : "Send question"}
                title={editingIndex !== null ? "Save edit" : undefined}
              >
                <IconArrowUpRight />
              </button>
            </>
          )}
        </div>
      </div>
    </form>
  );
}
