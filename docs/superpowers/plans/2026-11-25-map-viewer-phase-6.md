# Map Viewer Phase 6 Implementation Plan

> **For agentic workers:** This plan is being executed in the issue #40 worktree.

**Goal:** Harden the shipped VGMaps viewer only where review finds defects, then mark its documentation shipped.

**Architecture:** Review the parser, proxy/cache, viewer/panel state, persistence hook and responsive styles against the Phase 6 pitfalls. Make targeted fixes with focused regression checks, then run the issue's required checks and review the resulting diff.

**Tech Stack:** Next.js, React, TypeScript/JavaScript, CSS, Cache API, Supabase metadata sync.

**Spec:** `docs/plan/vgmaps-map-viewer.md` section 5 and Phase 6; GitHub issue #40.

## Global Constraints

- No annotations or new map features.
- Preserve signed-out map access and signed-in metadata sync.
- Keep proxy URLs restricted to listed VGMaps raster images and redirect hops.
- Respect the contrast rule in `.agents/AGENTS.md`.

## Review Focus

- Unusual/malformed VGMaps HTML must not throw or leak maps across game anchors.
- Redirects, query variants, and image responses must not bypass SSRF/type/size guards.
- Viewer close/unmount and Cache API cleanup must release large resources and stale binaries.
- Maps and Saved panes must remain mutually exclusive through history navigation.
- Both signed-out local saves and signed-in sync must remain usable when Supabase is absent.
- New UI states must remain legible at mobile and 1280×800 handheld sizes.

### Execution

- [ ] Inspect implementation and existing checks; record only reproducible defects.
- [ ] Add focused regression coverage and make minimal fixes for confirmed defects.
- [ ] Update `CLAUDE.md` and set the Phase 6 plan row to Shipped.
- [ ] Run `npm run check`, `npm run lint`, `npm run build`; inspect responsive behavior and contrast.
- [ ] Review diff, open PR #40, address feedback/check failures, and leave it for independent review.
