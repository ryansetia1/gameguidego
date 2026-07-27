export function AdminStyles() {
  return (
    <style
      dangerouslySetInnerHTML={{
        __html: `
        .admin-page-shell { width: min(100% - 32px, 1440px) !important; max-width: 1440px !important; margin: 0 auto; padding: 22px 0 32px; }
        .admin-page { max-width: 100% !important; margin: 0 auto; padding: 0 20px; width: 100%; }
        .admin-card { max-width: 100% !important; }
        .admin-head { display: flex; flex-wrap: wrap; gap: 16px; justify-content: space-between; align-items: flex-end; margin-bottom: 20px; }
        .admin-tabs { display: flex; gap: 0; border: 1px solid var(--line); }
        .admin-tab { padding: 10px 16px; font-size: 0.8rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); background: var(--paper); border-right: 1px solid var(--line); text-decoration: none; }
        .admin-tab:last-child { border-right: none; }
        .admin-tab--active { color: var(--on-signal); background: var(--signal); }
        .admin-tab:hover:not(.admin-tab--active) { background: var(--paper-strong); color: var(--ink); }
        .admin-tab--button { font: inherit; cursor: pointer; border: none; min-height: 44px; }
        .trace-view-tabs { margin-top: 1rem; width: fit-content; }
        .trace-cost strong { color: var(--ink); font-weight: 600; margin-right: 4px; }

        .kpi-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; margin: 0 0 20px; }
        .kpi-card { background: var(--paper-strong); border: 1px solid var(--line); padding: 14px; }
        .kpi-label { font-size: 0.72rem; color: var(--muted); text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 6px; font-weight: 600; }
        .kpi-value { font-size: 1.5rem; color: var(--ink); font-weight: 700; margin: 0; }
        .kpi-value--muted { font-size: 1.1rem; color: var(--muted); }
        .kpi-card--wide { grid-column: span 2; }

        .api-spend-grid { display: flex; flex-wrap: wrap; gap: 8px; }
        .api-spend-grid--kpi { margin-top: 4px; }
        .api-spend-chip { display: grid; gap: 4px; border: 1px solid var(--line); background: var(--paper); padding: 8px 10px; min-width: 120px; }
        .api-spend-chip-top { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
        .api-spend-chip-cost { font-size: 0.82rem; font-weight: 700; color: var(--ink); }
        .api-spend-chip-cost--muted { font-weight: 500; color: var(--muted); font-size: 0.72rem; }
        .api-spend-chip-tokens { display: block; font-size: 0.68rem; font-weight: 500; color: var(--muted); margin-top: 2px; }
        .api-spend-chip--total { border-color: var(--ink); background: var(--signal); color: var(--on-signal); }
        .api-spend-chip--total .api-spend-chip-label,
        .api-spend-chip--total .api-spend-chip-value,
        .api-spend-chip--total .api-spend-chip-cost,
        .api-spend-chip--total .api-spend-chip-cost--muted,
        .api-spend-chip--total .api-spend-chip-tokens { color: var(--on-signal); }
        .api-spend-chip-label { font-size: 0.72rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); }
        .api-spend-chip-value { font-size: 1.1rem; font-weight: 700; color: var(--ink); margin-left: auto; }
        .activity-spend-compact { font-variant-numeric: tabular-nums; }
        .activity-spend-total { color: var(--ink); }

        .activity-toolbar { display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 16px; align-items: center; }
        .activity-filter { padding: 8px 10px; border: 1px solid var(--line); background: var(--paper-strong); color: var(--ink); font: inherit; min-width: 140px; }
        .activity-range-filter { min-width: 160px; }
        .activity-search { flex: 1; min-width: 200px; padding: 8px 10px; border: 1px solid var(--line); background: var(--paper-strong); color: var(--ink); font: inherit; }

        .activity-list { display: flex; flex-direction: column; gap: 12px; }
        .activity-card { border: 1px solid var(--line); background: var(--paper-strong); overflow: hidden; }
        .activity-card--success { border-left: 4px solid var(--accent); }
        .activity-card--error { border-left: 4px solid var(--danger); }
        .activity-card--processing { border-left: 4px solid var(--warn); }
        .activity-summary { padding: 14px 16px; cursor: pointer; list-style: none; background: var(--paper); }
        .activity-summary::-webkit-details-marker { display: none; }
        .activity-summary:hover { background: var(--paper-strong); }
        .activity-top { display: flex; flex-wrap: wrap; gap: 8px 12px; align-items: center; margin-bottom: 8px; }
        .activity-badge { font-size: 0.68rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; padding: 2px 8px; border: 1px solid var(--line); background: var(--paper-strong); color: var(--ink); }
        .activity-badge--chat { border-color: var(--ink); }
        .activity-badge--ingest { background: var(--signal); border-color: var(--ink); color: var(--on-signal); }
        .activity-badge--check { background: var(--action); border-color: var(--action); color: #fff; }
        .activity-badge--upload { background: var(--paper-strong); }
        .activity-badge--memory { background: var(--warn); border-color: var(--ink); color: var(--ink); }
        .activity-badge--journey { background: var(--accent); border-color: var(--ink); color: var(--ink); }
        .activity-status { font-size: 0.68rem; font-weight: 700; text-transform: uppercase; }
        .activity-status--success { color: var(--accent); }
        .activity-status--error { color: var(--danger); }
        .activity-status--processing { color: var(--warn); }
        .activity-when { margin-left: auto; font-size: 0.78rem; color: var(--muted); white-space: nowrap; }
        .activity-title { font-size: 0.95rem; font-weight: 600; color: var(--ink); margin: 0 0 6px; }
        .activity-meta { display: flex; flex-wrap: wrap; gap: 6px 14px; font-size: 0.78rem; color: var(--muted); }
        .activity-meta strong { color: var(--ink); font-weight: 600; }
        .activity-meta-bar {
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 12px;
          flex-wrap: wrap;
          margin-top: 8px;
          padding-top: 8px;
          border-top: 1px dashed var(--line);
          font-size: 0.78rem;
          color: var(--muted);
        }
        .activity-meta-bar strong { color: var(--ink); font-weight: 600; }
        .activity-meta-bar-start { display: inline-flex; align-items: center; gap: 6px; flex-shrink: 0; min-height: 44px; }
        .activity-meta-bar-end { display: inline-flex; flex-wrap: wrap; gap: 10px 14px; justify-content: flex-end; margin-left: auto; text-align: right; }
        .activity-body { border-top: 1px solid var(--line); padding: 14px 16px; display: grid; gap: 14px; }
        .activity-block h3 { margin: 0 0 6px; font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); }
        .activity-block p, .activity-block pre { margin: 0; font-size: 0.88rem; line-height: 1.5; white-space: pre-wrap; word-break: break-word; }
        .activity-block pre { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.78rem; color: var(--text-subtle); background: var(--paper); border: 1px solid var(--line); padding: 10px; overflow-x: auto; max-height: 280px; }
        .activity-link { font-size: 0.8rem; color: var(--signal-dark); }
        .activity-trace-btn { font: inherit; font-size: 0.78rem; padding: 0; border: none; background: none; color: var(--signal-dark); cursor: pointer; text-decoration: underline; min-height: 44px; }
        .activity-meta-bar .activity-trace-btn { min-height: auto; }
        .activity-refresh { padding: 8px 12px; font-size: 0.78rem; min-height: 44px; }
        .activity-date-label { display: flex; }
        .activity-pagination { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; justify-content: center; margin-top: 20px; }
        .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; border: 0; }

        .llm-panel-list { display: flex; flex-direction: column; gap: 8px; }
        .llm-panel { border: 1px solid var(--line); background: var(--paper); }
        .llm-panel-summary { padding: 10px 12px; cursor: pointer; list-style: none; display: flex; flex-wrap: wrap; gap: 8px 12px; align-items: center; }
        .llm-panel-summary::-webkit-details-marker { display: none; }
        .llm-panel-body { border-top: 1px solid var(--line); padding: 12px; display: grid; gap: 12px; }
        .llm-kind { font-size: 0.72rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; }
        .llm-model { font-size: 0.82rem; color: var(--ink); font-weight: 600; }
        .llm-meta { font-size: 0.78rem; color: var(--muted); margin-left: auto; }

        .pipeline-section { border: 1px solid var(--line); background: var(--paper); }
        .pipeline-section-summary { padding: 10px 12px; cursor: pointer; list-style: none; font-size: 0.72rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); display: flex; align-items: center; gap: 8px; }
        .pipeline-section-summary::-webkit-details-marker { display: none; }
        .pipeline-section-count { font-size: 0.68rem; padding: 1px 6px; border: 1px solid var(--line); color: var(--ink); }
        .pipeline-section-body { border-top: 1px solid var(--line); padding: 12px; display: grid; gap: 12px; }
        .pipeline-kv { display: flex; flex-wrap: wrap; gap: 6px 14px; font-size: 0.78rem; color: var(--muted); }
        .pipeline-kv strong { color: var(--ink); font-weight: 600; }
        .pipeline-note { margin: 0; font-size: 0.82rem; color: var(--text-subtle); }
        .pipeline-hit-yes { color: var(--accent); font-weight: 700; }
        .pipeline-hit-no { color: var(--danger); font-weight: 700; }
        .activity-url { word-break: break-all; font-size: 0.82rem; color: var(--signal-dark); }

        .trace-list { margin-top: 1rem; display: flex; flex-direction: column; gap: 1rem; }
        .trace-details { border: 1px solid var(--line); background: var(--paper-strong); overflow: hidden; }
        .trace-details.status-finished { border-left: 4px solid var(--accent); }
        .trace-details.status-processing { border-left: 4px solid var(--warn); }
        .trace-details.status-new { border-left: 4px solid var(--action); }
        @keyframes admin-pulse {
          0% { opacity: 0.4; }
          50% { opacity: 1; }
          100% { opacity: 0.4; }
        }
        .trace-details[open] .trace-indicator { transform: rotate(90deg); }
        .trace-summary { padding: 1rem; cursor: pointer; list-style: none; user-select: none; background: var(--paper); }
        .trace-summary:hover { background: var(--paper-strong); }
        .trace-summary::-webkit-details-marker { display: none; }
        .trace-header { display: flex; align-items: center; gap: 1rem; }
        .trace-indicator { font-size: 0.8rem; color: var(--muted); transition: transform 0.2s; }
        .trace-id { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.9rem; color: var(--ink); font-weight: 500; }
        .trace-meta { font-size: 0.8rem; color: var(--muted); margin-top: 0.25rem; }
        .trace-table-container { border-top: 1px solid var(--line); overflow-x: auto; }
        .trace-table { width: 100%; border-collapse: collapse; text-align: left; font-size: 0.85rem; }
        .trace-table th { background: var(--paper); padding: 0.75rem 1rem; color: var(--text-subtle); font-weight: 600; border-bottom: 1px solid var(--line); }
        .trace-table td { padding: 0.75rem 1rem; border-bottom: 1px solid var(--line); color: var(--ink); }
        .trace-table tr:last-child td { border-bottom: none; }
        .trace-table tr:hover td { background: var(--paper-strong); }
        .time-cell { color: var(--muted) !important; white-space: nowrap; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
        .type-badge { background: var(--disabled-bg); color: var(--ink); padding: 0.25rem 0.5rem; font-size: 0.75rem; font-weight: 600; white-space: nowrap; }
        .type-badge--live { color: var(--warn); animation: admin-pulse 2s infinite; }
        .trace-row--live td { background: color-mix(in srgb, var(--warn) 6%, transparent); }
        .message-cell { font-weight: 500; }
        .latency-cell { color: var(--muted) !important; white-space: nowrap; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
        .meta-cell { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--text-subtle) !important; max-width: 300px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .meta-cell:hover { white-space: normal; word-break: break-all; }
        .trace-table--compact td, .trace-table--compact th { padding: 0.5rem 0.75rem; font-size: 0.8rem; }
        .trace-table--grouped .trace-id-cell { width: 4.5rem; padding-left: 0.65rem; color: var(--muted); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.72rem; white-space: nowrap; }
        .trace-id-chip { color: var(--text-subtle); }
        .trace-id-cont { color: var(--muted); opacity: 0.45; }
        .trace-row--trace-start td { border-top: 1px solid color-mix(in srgb, var(--muted) 28%, var(--line)); }
        .trace-table--grouped .trace-row--tone-0 .trace-id-cell { box-shadow: inset 3px 0 0 transparent; }
        .trace-table--grouped .trace-row--tone-1 .trace-id-cell { box-shadow: inset 3px 0 0 color-mix(in srgb, var(--signal) 22%, transparent); }
        .trace-table--grouped .trace-row--tone-2 .trace-id-cell { box-shadow: inset 3px 0 0 color-mix(in srgb, var(--action) 22%, transparent); }
        .trace-table--grouped .trace-row--tone-3 .trace-id-cell { box-shadow: inset 3px 0 0 color-mix(in srgb, var(--warn) 22%, transparent); }
        .trace-live-section { margin-top: 1.25rem; display: grid; gap: 10px; }
        .trace-section-head h2 { margin: 0; font-size: 0.95rem; color: var(--ink); }
        .trace-section-head { display: grid; gap: 4px; }
        .trace-header-row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
        .trace-question { margin: 6px 0 0; font-size: 0.9rem; font-weight: 600; color: var(--ink); }
        .trace-pipeline { font-size: 0.72rem; font-weight: 700; text-transform: uppercase; color: var(--muted); }
        .trace-toggle { display: inline-flex; align-items: center; gap: 8px; font-size: 0.8rem; color: var(--muted); min-height: 44px; }
        .trace-details.status-processing { border-left-color: var(--warn); }

        .admin-skeleton { display: grid; gap: 16px; }
        .admin-skeleton-block {
          background: linear-gradient(90deg, var(--paper-strong) 25%, var(--paper) 50%, var(--paper-strong) 75%);
          background-size: 200% 100%;
          animation: admin-skeleton-shimmer 1.2s ease-in-out infinite;
          border: 1px solid var(--line);
        }
        .admin-skeleton-kpi { margin: 0; }
        .admin-skeleton-kpi-card { min-height: 72px; }
        .admin-skeleton-kpi-card--wide { grid-column: span 2; }
        .admin-skeleton-note { height: 18px; width: min(280px, 70%); }
        .admin-skeleton-toolbar { height: 44px; width: 100%; }
        .admin-skeleton-tabs { height: 44px; width: min(280px, 100%); }
        .admin-skeleton-list { display: grid; gap: 12px; }
        .admin-skeleton-activity-card { min-height: 120px; }
        .admin-skeleton-trace-card { min-height: 96px; }
        @keyframes admin-skeleton-shimmer {
          0% { background-position: 200% 0; }
          100% { background-position: -200% 0; }
        }
        @media (prefers-reduced-motion: reduce) {
          .admin-skeleton-block { animation: none; }
        }
      `,
      }}
    />
  );
}
