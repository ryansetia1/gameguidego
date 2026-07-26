"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";
import {
  dateRangeBounds,
  mergeActivityRows,
  type ActivityRow,
  type IngestLogRow,
  type LlmCallRow,
  type SolveLogRow,
} from "@/lib/admin-activity";
import { buildTraceApiCost, type ApiCostSummary, type LlmCallCostInput } from "@/lib/admin-api-cost";
import {
  compactTraceEventsForLiveFeed,
  groupTraceEvents,
  type GroupedTrace,
  type TraceEventRow,
} from "@/lib/admin-traces";
import { getSupabase } from "@/lib/supabase";
import { useAdminAuth } from "@/app/admin/use-admin-auth";

const EVENT_LIMIT = 1000;
const LIVE_FEED_LIMIT = 60;
const LLM_LIMIT = 500;

export type TraceLlmCallRow = LlmCallCostInput & {
  trace_id: string | null;
  created_at: string;
};

type DateRange = { from: string; to: string };

type AdminDataContextValue = {
  live: boolean;
  setLive: Dispatch<SetStateAction<boolean>>;
  activityRows: ActivityRow[];
  activityLoading: boolean;
  activityError: string | null;
  activityReady: boolean;
  loadActivity: (range: DateRange, opts?: { force?: boolean }) => Promise<void>;
  setActivityLiveRange: (range: DateRange | null) => void;
  traces: GroupedTrace[];
  liveFeed: TraceEventRow[];
  traceCosts: Map<string, ApiCostSummary>;
  llmCallsByTrace: Map<string, LlmCallCostInput[]>;
  processingCount: number;
  tracesLoading: boolean;
  tracesError: string | null;
  tracesReady: boolean;
  loadTraces: (opts?: { force?: boolean }) => Promise<void>;
};

const AdminDataContext = createContext<AdminDataContextValue | null>(null);

function activityRangeKey(range: DateRange): string {
  return `${range.from}|${range.to}`;
}

export function AdminDataProvider({ children }: { children: ReactNode }) {
  const { isAdmin } = useAdminAuth();
  const [live, setLive] = useState(true);

  const [activityRows, setActivityRows] = useState<ActivityRow[]>([]);
  const [activityCacheKey, setActivityCacheKey] = useState<string | null>(null);
  const [activityLoading, setActivityLoading] = useState(false);
  const [activityError, setActivityError] = useState<string | null>(null);
  const [activityLiveRange, setActivityLiveRange] = useState<DateRange | null>(null);

  const [traceEvents, setTraceEvents] = useState<TraceEventRow[]>([]);
  const [llmCalls, setLlmCalls] = useState<TraceLlmCallRow[]>([]);
  const [tracesLoading, setTracesLoading] = useState(false);
  const [tracesError, setTracesError] = useState<string | null>(null);
  const [tracesReady, setTracesReady] = useState(false);

  const activityLiveRangeRef = useRef<DateRange | null>(null);
  const activityCacheKeyRef = useRef<string | null>(null);
  const activityRowsRef = useRef<ActivityRow[]>([]);
  const tracesReadyRef = useRef(false);
  const traceEventsRef = useRef<TraceEventRow[]>([]);
  activityLiveRangeRef.current = activityLiveRange;
  activityCacheKeyRef.current = activityCacheKey;
  activityRowsRef.current = activityRows;
  tracesReadyRef.current = tracesReady;
  traceEventsRef.current = traceEvents;

  const loadActivity = useCallback(
    async (range: DateRange, opts?: { force?: boolean }) => {
      const supabase = getSupabase();
      if (!supabase || !isAdmin) return;

      const key = activityRangeKey(range);
      if (!opts?.force && activityCacheKeyRef.current === key && activityRowsRef.current.length > 0) return;

      const showSkeleton = activityCacheKeyRef.current !== key || activityRowsRef.current.length === 0;
      if (showSkeleton) {
        setActivityLoading(true);
        if (activityCacheKeyRef.current !== key) setActivityRows([]);
      }

      try {
        const { data: sessionData } = await supabase.auth.getSession();
        if (!sessionData.session) {
          setActivityError("Session expired. Sign in again from Profile.");
          setActivityRows([]);
          setActivityCacheKey(null);
          return;
        }

        const { fromIso, toIso } = dateRangeBounds(range.from, range.to);

        const [solveRes, ingestRes, traceRes, llmRes] = await Promise.all([
          supabase
            .from("solve_logs")
            .select(
              "id, created_at, user_id, player_name, trace_id, game, platform, question, preferred_urls, pipeline_type, rewrite_latency_ms, retrieval_latency_ms, generation_latency_ms, total_latency_ms, status, error_message, answer, sources",
            )
            .gte("created_at", fromIso)
            .lte("created_at", toIso)
            .order("created_at", { ascending: false })
            .limit(300),
          supabase
            .from("ingest_logs")
            .select(
              "id, created_at, user_id, player_name, trace_id, game, platform, url, latency_ms, status, pages_indexed, pages_missing, hub_warning, error_message",
            )
            .gte("created_at", fromIso)
            .lte("created_at", toIso)
            .order("created_at", { ascending: false })
            .limit(300),
          supabase
            .from("trace_events")
            .select("trace_id, created_at, event_type, message, latency_ms, metadata")
            .gte("created_at", fromIso)
            .lte("created_at", toIso)
            .order("created_at", { ascending: false })
            .limit(800),
          supabase
            .from("llm_calls")
            .select(
              "id, trace_id, created_at, kind, model, game, system_instruction, prompt, response, input_tokens, output_tokens, duration_ms",
            )
            .gte("created_at", fromIso)
            .lte("created_at", toIso)
            .order("created_at", { ascending: false })
            .limit(500),
        ]);

        if (solveRes.error || ingestRes.error || traceRes.error || llmRes.error) {
          setActivityError(
            solveRes.error?.message ||
              ingestRes.error?.message ||
              traceRes.error?.message ||
              llmRes.error?.message ||
              "Failed to load activity",
          );
          return;
        }

        const grouped = groupTraceEvents((traceRes.data ?? []) as TraceEventRow[]);
        const userIds = [
          ...new Set(
            [
              ...((solveRes.data ?? []) as SolveLogRow[]).map((row) => row.user_id),
              ...((ingestRes.data ?? []) as IngestLogRow[]).map((row) => row.user_id),
            ].filter((id): id is string => typeof id === "string" && id.length > 0),
          ),
        ];

        let userLabels: Record<string, string> = {};
        let userEmails: Record<string, string> = {};
        if (userIds.length && sessionData.session.access_token) {
          try {
            const labelRes = await fetch("/api/admin/user-labels", {
              method: "POST",
              headers: {
                Authorization: `Bearer ${sessionData.session.access_token}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({ userIds }),
            });
            if (labelRes.ok) {
              const payload = (await labelRes.json()) as {
                labels?: Record<string, string>;
                emails?: Record<string, string>;
              };
              userLabels = payload.labels ?? {};
              userEmails = payload.emails ?? {};
            }
          } catch {
            // Best-effort display names.
          }
        }

        setActivityError(null);
        setActivityRows(
          mergeActivityRows({
            solveLogs: (solveRes.data ?? []) as SolveLogRow[],
            ingestLogs: (ingestRes.data ?? []) as IngestLogRow[],
            traces: grouped,
            llmCalls: (llmRes.data ?? []) as LlmCallRow[],
            userLabels,
            userEmails,
            limit: 500,
          }),
        );
        setActivityCacheKey(key);
      } catch (error) {
        setActivityError(error instanceof Error ? error.message : "Failed to load activity");
        setActivityRows([]);
        setActivityCacheKey(null);
      } finally {
        setActivityLoading(false);
      }
    },
    [isAdmin],
  );

  const loadTraces = useCallback(
    async (opts?: { force?: boolean }) => {
      const supabase = getSupabase();
      if (!supabase || !isAdmin) return;
      if (!opts?.force && tracesReadyRef.current && traceEventsRef.current.length > 0) return;

      const showSkeleton = !tracesReadyRef.current || traceEventsRef.current.length === 0;
      if (showSkeleton) setTracesLoading(true);

      const [traceRes, llmRes] = await Promise.all([
        supabase
          .from("trace_events")
          .select("trace_id, created_at, event_type, message, latency_ms, metadata")
          .order("created_at", { ascending: false })
          .limit(EVENT_LIMIT),
        supabase
          .from("llm_calls")
          .select("trace_id, created_at, kind, model, prompt, input_tokens, output_tokens")
          .not("trace_id", "is", null)
          .order("created_at", { ascending: false })
          .limit(LLM_LIMIT),
      ]);

      if (traceRes.error) {
        setTracesError(traceRes.error.message);
        setTraceEvents([]);
        setLlmCalls([]);
        setTracesLoading(false);
        return;
      }

      setTracesError(null);
      setTraceEvents((traceRes.data ?? []) as TraceEventRow[]);
      setLlmCalls((llmRes.data ?? []) as TraceLlmCallRow[]);
      setTracesReady(true);
      setTracesLoading(false);
    },
    [isAdmin],
  );

  useEffect(() => {
    if (!isAdmin) return;
    void loadTraces();
  }, [isAdmin, loadTraces]);

  useEffect(() => {
    if (!isAdmin || !live) return;
    const supabase = getSupabase();
    if (!supabase) return;

    const channel = supabase
      .channel("admin-traces-live")
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "trace_events" }, (payload) => {
        const row = payload.new as TraceEventRow;
        setTraceEvents((prev) => {
          const next = [
            row,
            ...prev.filter((event) => event.created_at !== row.created_at || event.event_type !== row.event_type),
          ];
          return next.slice(0, EVENT_LIMIT);
        });
      })
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "llm_calls" }, (payload) => {
        const row = payload.new as TraceLlmCallRow;
        if (!row.trace_id) return;
        setLlmCalls((prev) => {
          const next = [row, ...prev.filter((call) => call.created_at !== row.created_at || call.kind !== row.kind)];
          return next.slice(0, LLM_LIMIT);
        });
      })
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [isAdmin, live]);

  useEffect(() => {
    if (!isAdmin || !live || !activityLiveRange) return;
    const supabase = getSupabase();
    if (!supabase) return;

    const refreshActivity = () => {
      const range = activityLiveRangeRef.current;
      if (range) void loadActivity(range, { force: true });
    };

    const channel = supabase
      .channel("admin-activity-live")
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "solve_logs" }, refreshActivity)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "ingest_logs" }, refreshActivity)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "trace_events" }, refreshActivity)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "llm_calls" }, refreshActivity)
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [activityLiveRange, isAdmin, live, loadActivity]);

  const traces = useMemo(() => groupTraceEvents(traceEvents), [traceEvents]);
  const liveFeed = useMemo(() => compactTraceEventsForLiveFeed(traceEvents, LIVE_FEED_LIMIT), [traceEvents]);

  const llmCallsByTrace = useMemo(() => {
    const map = new Map<string, LlmCallCostInput[]>();
    for (const call of llmCalls) {
      if (!call.trace_id) continue;
      const list = map.get(call.trace_id) ?? [];
      list.push(call);
      map.set(call.trace_id, list);
    }
    return map;
  }, [llmCalls]);

  const traceCosts = useMemo(() => {
    const map = new Map<string, ApiCostSummary>();
    for (const trace of traces) {
      const cost = buildTraceApiCost(trace.events, llmCallsByTrace.get(trace.traceId) ?? []);
      if (cost) map.set(trace.traceId, cost);
    }
    return map;
  }, [traces, llmCallsByTrace]);

  const processingCount = traces.filter((trace) => trace.status !== "Finished").length;

  const value = useMemo<AdminDataContextValue>(
    () => ({
      live,
      setLive,
      activityRows,
      activityLoading,
      activityError,
      activityReady: activityCacheKey != null && activityRows.length > 0,
      loadActivity,
      setActivityLiveRange,
      traces,
      liveFeed,
      traceCosts,
      llmCallsByTrace,
      processingCount,
      tracesLoading,
      tracesError,
      tracesReady,
      loadTraces,
    }),
    [
      live,
      activityRows,
      activityLoading,
      activityError,
      activityCacheKey,
      loadActivity,
      traces,
      liveFeed,
      traceCosts,
      llmCallsByTrace,
      processingCount,
      tracesLoading,
      tracesError,
      tracesReady,
      loadTraces,
    ],
  );

  return <AdminDataContext.Provider value={value}>{children}</AdminDataContext.Provider>;
}

export function useAdminData(): AdminDataContextValue {
  const context = useContext(AdminDataContext);
  if (!context) {
    throw new Error("useAdminData must be used within AdminDataProvider");
  }
  return context;
}
