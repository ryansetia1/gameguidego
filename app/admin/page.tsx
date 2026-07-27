"use client";

import { useEffect, useMemo, useState } from "react";
import { ActivityCard } from "@/app/admin/activity-card";
import { useAdminData } from "@/app/admin/admin-data-provider";
import { AdminSkeleton } from "@/app/admin/admin-skeleton";
import { DateRangeSelect } from "@/app/admin/date-range-select";
import { useAdminFx } from "@/app/admin/use-admin-fx";
import { AdminShell } from "@/app/admin/admin-shell";
import { useAdminAuth } from "@/app/admin/use-admin-auth";
import {
  dateRangeForPreset,
  DEFAULT_ADMIN_DATE_PRESET,
  type ActivityType,
  type AdminDateRangePreset,
} from "@/lib/admin-activity";
import { mergeApiSpendTotals } from "@/lib/admin-api-spend";
import { mergeApiCostTotals } from "@/lib/admin-api-cost";
import { activityRowMatchesSearch } from "@/lib/admin-search";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 25;

const TYPE_OPTIONS: Array<{ value: "all" | ActivityType; label: string }> = [
  { value: "all", label: "All types" },
  { value: "chat", label: "Chat" },
  { value: "guide_ingest", label: "Guide ingest" },
  { value: "guide_check", label: "Guide check" },
  { value: "guide_upload", label: "Guide upload" },
  { value: "player_memory", label: "Player memory" },
  { value: "player_journey", label: "Player journey" },
];

export default function AdminActivityPage() {
  const { user, loading, isAdmin } = useAdminAuth();
  const {
    live,
    setLive,
    activityRows: rows,
    activityLoading,
    activityError: errorMsg,
    loadActivity,
    setActivityLiveRange,
  } = useAdminData();
  const [typeFilter, setTypeFilter] = useState<"all" | ActivityType>("all");
  const [search, setSearch] = useState("");
  const [datePreset, setDatePreset] = useState<AdminDateRangePreset>(DEFAULT_ADMIN_DATE_PRESET);
  const dateRange = useMemo(() => dateRangeForPreset(datePreset), [datePreset]);
  const [page, setPage] = useState(1);
  const [copiedTraceId, setCopiedTraceId] = useState<string | null>(null);
  const fx = useAdminFx(isAdmin);

  useEffect(() => {
    setActivityLiveRange(dateRange);
    return () => setActivityLiveRange(null);
  }, [dateRange, setActivityLiveRange]);

  useEffect(() => {
    if (!isAdmin) return;
    void loadActivity(dateRange);
  }, [dateRange, isAdmin, loadActivity]);

  const showSkeleton = activityLoading && rows.length === 0;

  useEffect(() => {
    setPage(1);
  }, [typeFilter, search, datePreset]);

  const filtered = useMemo(() => {
    return rows.filter((row) => {
      if (typeFilter !== "all" && row.type !== typeFilter) return false;
      return activityRowMatchesSearch(row, search);
    });
  }, [rows, search, typeFilter]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const pageRows = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const stats = useMemo(() => {
    const chat = rows.filter((r) => r.type === "chat").length;
    const ingest = rows.filter((r) => r.type === "guide_ingest").length;
    const errors = rows.filter((r) => r.status === "error").length;
    const apiSpend = mergeApiSpendTotals(rows.map((row) => row.pipeline?.apiSpend));
    const apiCost = mergeApiCostTotals(rows.map((row) => row.pipeline?.apiCost));
    return { total: rows.length, chat, ingest, errors, apiSpend, apiCost };
  }, [rows]);

  const handleCopyTrace = async (traceId: string) => {
    try {
      await navigator.clipboard.writeText(traceId);
      setCopiedTraceId(traceId);
      setTimeout(() => setCopiedTraceId(null), 2000);
    } catch {
      // clipboard blocked
    }
  };

  return (
    <>
      <AdminShell
        user={user}
        loading={loading}
        actions={
          <span className="profile-hint" style={{ fontSize: "0.8rem" }}>
            <span
              style={{
                display: "inline-block",
                width: "8px",
                height: "8px",
                background: live ? "var(--signal)" : "var(--muted)",
                marginRight: "6px",
              }}
            />
            {live ? "Live" : "Paused"}
          </span>
        }
      >
        {showSkeleton ? (
          <AdminSkeleton variant="activity" />
        ) : (
          <>
        <div className="kpi-grid">
          <div className="kpi-card">
            <div className="kpi-label">In range</div>
            <div className="kpi-value">{stats.total}</div>
          </div>
          <div className="kpi-card">
            <div className="kpi-label">Chat</div>
            <div className="kpi-value">{stats.chat}</div>
          </div>
          <div className="kpi-card">
            <div className="kpi-label">Ingests</div>
            <div className="kpi-value">{stats.ingest}</div>
          </div>
          <div className="kpi-card">
            <div className="kpi-label">Errors</div>
            <div className="kpi-value">{stats.errors}</div>
          </div>
          <div className="kpi-card kpi-card--wide">
            <div className="kpi-label">API calls in range</div>
            {stats.apiSpend ? (
              <div className="api-spend-grid api-spend-grid--kpi">
                {stats.apiSpend.lines.map((line) => {
                  const priced = stats.apiCost?.lines.find((costLine) => costLine.key === line.key);
                  return (
                    <div key={line.key} className="api-spend-chip">
                      <div className="api-spend-chip-top">
                        <span className="api-spend-chip-label">{line.label}</span>
                        <span className="api-spend-chip-value">{line.count}</span>
                      </div>
                      {priced?.costUsd != null ? (
                        <div className="api-spend-chip-cost">{fx.formatCost(priced.costUsd)}</div>
                      ) : null}
                    </div>
                  );
                })}
                <div className="api-spend-chip api-spend-chip--total">
                  <div className="api-spend-chip-top">
                    <span className="api-spend-chip-label">Calls</span>
                    <span className="api-spend-chip-value">{stats.apiSpend.total}</span>
                  </div>
                  {stats.apiCost ? (
                    <div className="api-spend-chip-cost">Est. {fx.formatCost(stats.apiCost.knownTotalUsd)}</div>
                  ) : null}
                </div>
              </div>
            ) : (
              <p className="kpi-value kpi-value--muted">0</p>
            )}
          </div>
        </div>
        <p className="profile-hint admin-fx-note">{fx.rateLabel}</p>

        <div className="activity-toolbar">
          <select
            className="activity-filter"
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value as "all" | ActivityType)}
            aria-label="Filter by activity type"
          >
            {TYPE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
          <DateRangeSelect value={datePreset} onChange={setDatePreset} />
          <input
            className="activity-search"
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search user, game, question, prompt..."
            aria-label="Search activity"
          />
          <button type="button" className="nav-button activity-refresh" onClick={() => void loadActivity(dateRange, { force: true })}>
            Refresh
          </button>
          <button
            type="button"
            className="nav-button activity-refresh"
            onClick={() => setLive((prev) => !prev)}
            aria-pressed={live}
          >
            {live ? "Pause live" : "Resume live"}
          </button>
        </div>

        {errorMsg ? <p className="profile-error">Error loading activity: {errorMsg}</p> : null}

        <div className="activity-list">
          {pageRows.length === 0 && !errorMsg ? (
            <p className="profile-hint" style={{ textAlign: "center", marginTop: "2rem" }}>
              No activity in this range. Try widening the dates or run a chat.
            </p>
          ) : null}
          {pageRows.map((row) => (
            <ActivityCard
              key={row.id}
              row={row}
              onCopyTrace={(id) => void handleCopyTrace(id)}
              copiedTraceId={copiedTraceId}
              formatCost={fx.formatCost}
              formatCostCompact={fx.formatCostCompact}
              fxRateLabel={fx.asOf ?? undefined}
            />
          ))}
        </div>

        {filtered.length > PAGE_SIZE ? (
          <div className="activity-pagination">
            <button
              type="button"
              className="nav-button"
              disabled={page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              Previous
            </button>
            <span className="profile-hint">
              Page {page} of {pageCount} ({filtered.length} rows)
            </span>
            <button
              type="button"
              className="nav-button"
              disabled={page >= pageCount}
              onClick={() => setPage((p) => Math.min(pageCount, p + 1))}
            >
              Next
            </button>
          </div>
        ) : null}
          </>
        )}
      </AdminShell>
    </>
  );
}
