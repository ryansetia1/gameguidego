"use client";

import { useEffect, useMemo, useState } from "react";
import { useAdminData } from "@/app/admin/admin-data-provider";
import { AdminSkeleton } from "@/app/admin/admin-skeleton";
import { AdminShell } from "@/app/admin/admin-shell";
import { TraceCard } from "@/app/admin/trace-card";
import { TraceEventsTable } from "@/app/admin/trace-events-table";
import { useAdminAuth } from "@/app/admin/use-admin-auth";
import { useAdminFx } from "@/app/admin/use-admin-fx";
import { buildTraceEventCostMap, findTraceEventIndex } from "@/lib/admin-trace-event-cost";
import { traceMatchesSearch } from "@/lib/admin-search";

export const dynamic = "force-dynamic";

type TraceView = "trace" | "feed";

export default function AdminTracesPage() {
  const { user, loading, isAdmin } = useAdminAuth();
  const fx = useAdminFx(isAdmin);
  const {
    live,
    setLive,
    traces,
    liveFeed,
    traceCosts,
    llmCallsByTrace,
    processingCount,
    tracesLoading,
    tracesError: errorMsg,
    loadTraces,
    tracesReady,
  } = useAdminData();
  const [view, setView] = useState<TraceView>("trace");
  const [search, setSearch] = useState("");
  const [showFinished, setShowFinished] = useState(true);
  const [copiedTraceId, setCopiedTraceId] = useState<string | null>(null);

  useEffect(() => {
    if (!isAdmin) return;
    void loadTraces();
  }, [isAdmin, loadTraces]);

  const showSkeleton = tracesLoading && !tracesReady;

  const traceEventCostByIndex = useMemo(() => {
    const map = new Map<string, Map<number, number | null>>();
    for (const trace of traces) {
      map.set(
        trace.traceId,
        buildTraceEventCostMap(trace.events, llmCallsByTrace.get(trace.traceId) ?? []),
      );
    }
    return map;
  }, [traces, llmCallsByTrace]);

  const liveFeedCostByIndex = useMemo(() => {
    const map = new Map<number, number | null>();
    const traceById = new Map(traces.map((trace) => [trace.traceId, trace]));
    liveFeed.forEach((event, feedIndex) => {
      const trace = traceById.get(event.trace_id);
      if (!trace) return;
      const traceIndex = findTraceEventIndex(trace.events, event);
      if (traceIndex < 0) return;
      const costs = traceEventCostByIndex.get(event.trace_id);
      if (!costs?.has(traceIndex)) return;
      map.set(feedIndex, costs.get(traceIndex) ?? null);
    });
    return map;
  }, [liveFeed, traces, traceEventCostByIndex]);

  const filteredTraces = useMemo(() => {
    return traces.filter((trace) => {
      if (!showFinished && trace.status === "Finished") return false;
      return traceMatchesSearch(trace, search);
    });
  }, [search, showFinished, traces]);

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
        subtitle="Grouped traces with cost estimates. Live feed clusters events by trace."
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
          <AdminSkeleton variant="traces" />
        ) : (
          <>
        <div className="kpi-grid">
          <div className="kpi-card">
            <div className="kpi-label">Traces loaded</div>
            <div className="kpi-value">{traces.length}</div>
          </div>
          <div className="kpi-card">
            <div className="kpi-label">Processing</div>
            <div className="kpi-value">{processingCount}</div>
          </div>
          <div className="kpi-card">
            <div className="kpi-label">Live feed</div>
            <div className="kpi-value">{liveFeed.length}</div>
          </div>
        </div>
        <p className="profile-hint admin-fx-note">{fx.rateLabel}</p>

        <div className="activity-toolbar">
          <input
            className="activity-search"
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search trace id, game, event type..."
            aria-label="Search traces"
          />
          <label className="trace-toggle">
            <input
              type="checkbox"
              checked={showFinished}
              onChange={(event) => setShowFinished(event.target.checked)}
            />
            Show finished
          </label>
          <button type="button" className="nav-button activity-refresh" onClick={() => void loadTraces({ force: true })}>
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

        <div className="admin-tabs trace-view-tabs" role="tablist" aria-label="Trace views">
          <button
            type="button"
            role="tab"
            aria-selected={view === "trace"}
            className={view === "trace" ? "admin-tab admin-tab--active admin-tab--button" : "admin-tab admin-tab--button"}
            onClick={() => setView("trace")}
          >
            Per trace
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={view === "feed"}
            className={view === "feed" ? "admin-tab admin-tab--active admin-tab--button" : "admin-tab admin-tab--button"}
            onClick={() => setView("feed")}
          >
            Live feed
          </button>
        </div>

        {errorMsg ? <p className="profile-error">Error loading traces: {errorMsg}</p> : null}

        {view === "trace" ? (
          <section className="trace-live-section">
            <div className="trace-section-head">
              <h2>Per trace</h2>
              <p className="profile-hint">One expand per trace. Active runs stay open so you can watch events land.</p>
            </div>
            <div className="trace-list">
              {filteredTraces.length === 0 && !errorMsg ? (
                <p className="profile-hint" style={{ textAlign: "center", marginTop: "1rem" }}>
                  No traces match your filters.
                </p>
              ) : null}
              {filteredTraces.map((trace) => (
                <TraceCard
                  key={trace.traceId}
                  trace={trace}
                  copiedTraceId={copiedTraceId}
                  onCopyTrace={(id) => void handleCopyTrace(id)}
                  apiCost={traceCosts.get(trace.traceId)}
                  llmCalls={llmCallsByTrace.get(trace.traceId)}
                  formatCost={fx.formatCost}
                />
              ))}
            </div>
          </section>
        ) : (
          <section className="trace-live-section">
            <div className="trace-section-head">
              <h2>Live feed</h2>
              <p className="profile-hint">Latest events grouped by trace (newest trace first). Cost only on completed Replicate or Sumopod steps.</p>
            </div>
            {liveFeed.length ? (
              <TraceEventsTable
                events={liveFeed}
                compact
                showTraceGroups
                formatCost={fx.formatCost}
                eventCostByIndex={liveFeedCostByIndex}
              />
            ) : (
              <p className="profile-hint">No trace events yet. Run a chat to populate this feed.</p>
            )}
          </section>
        )}
          </>
        )}
      </AdminShell>
    </>
  );
}
