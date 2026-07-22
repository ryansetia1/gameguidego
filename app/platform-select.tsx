"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";

import { matchPlatforms } from "@/lib/platforms";
import { ClearButton } from "./clear-button";
import { IconChevronDown, IconX } from "./icons";

type Props = {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
};

export function PlatformSelect({ value, onChange, disabled }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listId = useId();

  const groups = useMemo(() => matchPlatforms(query), [query]);

  const flat = useMemo(() => groups.flatMap((section) => section.items), [groups]);
  const trimmed = query.trim();
  // Only offer custom when the matcher found nothing (aliases like ps1 → PS1 count as a hit).
  const showCustom = trimmed.length > 0 && flat.length === 0;
  const navCount = flat.length + (showCustom ? 1 : 0);

  useEffect(() => {
    setActive(0);
  }, [query, showCustom]);

  useEffect(() => {
    if (open) searchRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  function commit(next: string) {
    onChange(next);
    setOpen(false);
    setQuery("");
  }

  function pickAt(index: number) {
    if (showCustom && index === 0) commit(trimmed);
    else commit(flat[showCustom ? index - 1 : index]);
  }

  function onSearchKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((i) => Math.min(i + 1, navCount - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (navCount > 0) pickAt(active);
    } else if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
    }
  }

  return (
    <div className="combo" ref={rootRef}>
      <button
        type="button"
        className="combo-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        disabled={disabled}
        onClick={() => setOpen((prev) => !prev)}
      >
        <span className={value ? "" : "placeholder"}>
          {value || "Select platform (optional)"}
        </span>
        {value ? (
          <span
            className="combo-clear"
            role="button"
            tabIndex={-1}
            aria-label="Clear platform"
            onClick={(event) => {
              event.stopPropagation();
              commit("");
            }}
          >
            <IconX />
          </span>
        ) : (
          <span className="combo-caret" aria-hidden="true">
            <IconChevronDown />
          </span>
        )}
      </button>

      {open && (
        <div className="combo-panel">
          <div className="field-clear-wrap">
            <input
              ref={searchRef}
              className="combo-search"
              type="text"
              value={query}
              placeholder="Search platform..."
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={onSearchKeyDown}
              aria-label="Search platform"
              autoComplete="off"
            />
            <ClearButton
              show={query.length > 0}
              onClear={() => {
                setQuery("");
                searchRef.current?.focus();
              }}
              label="Clear search"
            />
          </div>
          <ul className="combo-list" id={listId} role="listbox">
            {showCustom && (
              <li
                role="option"
                aria-selected={active === 0}
                className={`combo-option combo-option-custom${active === 0 ? " active" : ""}`}
                onMouseEnter={() => setActive(0)}
                onClick={() => commit(trimmed)}
              >
                Use &ldquo;{trimmed}&rdquo;
              </li>
            )}
            {flat.length === 0 && !showCustom && (
              <li className="combo-empty">No matching platforms</li>
            )}
            {groups.map((section) => (
              <li key={section.group} role="presentation">
                <p className="combo-group-label">{section.group}</p>
                <ul role="presentation">
                  {section.items.map((item) => {
                    const index = flat.indexOf(item) + (showCustom ? 1 : 0);
                    return (
                      <li
                        key={item}
                        role="option"
                        aria-selected={item === value}
                        className={`combo-option${index === active ? " active" : ""}`}
                        onMouseEnter={() => setActive(index)}
                        onClick={() => commit(item)}
                      >
                        {item}
                      </li>
                    );
                  })}
                </ul>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
