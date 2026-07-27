import type { GroupedTrace, TraceEventRow } from "@/lib/admin-traces";
import { buildActivityPipeline, type ActivityPipeline } from "@/lib/admin-pipeline";
import {
  linkLlmCallsForIngest,
  linkLlmCallsForSolve,
  resolveSolveTraceId,
  resolveTracePlayerName,
  traceStartMs,
} from "@/lib/admin-link";

export type ActivityType = "chat" | "guide_ingest" | "guide_check" | "guide_upload" | "player_memory" | "player_journey";

export type ActivityStatus = "success" | "error" | "processing";

export type LlmCallRow = {
  id: string;
  trace_id: string | null;
  created_at: string;
  kind: string;
  model: string;
  game?: string | null;
  system_instruction: string;
  prompt: string;
  response: string;
  input_tokens?: number | null;
  output_tokens?: number | null;
  duration_ms?: number | null;
};

export type ActivityRow = {
  id: string;
  type: ActivityType;
  createdAt: string;
  status: ActivityStatus;
  userLabel: string;
  userEmail?: string | null;
  userId: string | null;
  game: string | null;
  platform: string | null;
  provider: string;
  service: string;
  summary: string;
  question: string | null;
  answer: string | null;
  traceId?: string;
  latencyMs?: number | null;
  llmCalls?: LlmCallRow[];
  traceEvents?: TraceEventRow[];
  pipeline?: ActivityPipeline;
  technical?: Record<string, unknown>;
};

export type SolveLogRow = {
  id: string;
  created_at: string;
  user_id: string | null;
  player_name?: string | null;
  trace_id?: string | null;
  game: string | null;
  platform: string | null;
  question: string;
  preferred_urls?: unknown;
  pipeline_type: string | null;
  rewrite_latency_ms?: number | null;
  retrieval_latency_ms?: number | null;
  generation_latency_ms?: number | null;
  total_latency_ms?: number | null;
  status: "success" | "error";
  error_message?: string | null;
  answer?: string | null;
  sources?: unknown;
};

export type IngestLogRow = {
  id: string;
  created_at: string;
  user_id: string | null;
  player_name?: string | null;
  trace_id?: string | null;
  game: string | null;
  platform: string | null;
  url: string;
  latency_ms?: number | null;
  status: "success" | "error";
  pages_indexed?: number | null;
  pages_missing?: number | null;
  hub_warning?: boolean | null;
  error_message?: string | null;
};

const FALLBACK_PROVIDER = "Unknown model";

function userLabel(
  userId: string | null | undefined,
  playerName?: string | null,
  emailLabel?: string | null,
): string {
  if (playerName?.trim()) return playerName.trim();
  if (emailLabel?.trim()) return emailLabel.trim();
  if (userId) return `User ${userId.slice(0, 8)}`;
  return "Guest";
}

function pipelineService(pipeline: string | null | undefined): string {
  switch (pipeline) {
    case "rag":
      return "Preferred guide RAG";
    case "rag_supplemented":
      return "Guide + web";
    case "web":
      return "Web search";
    case "web_skip_guide":
      return "Web search (guide skipped)";
    case "fallback_web":
      return "Web fallback";
    case "knowledge_only":
      return "Model knowledge";
    default:
      return pipeline || "Chat";
  }
}

export function providerFromLlmCalls(calls: LlmCallRow[]): string {
  const priority = ["summarize", "memory_summarize", "rewrite", "censor", "embed_index", "embed_query"];
  for (const kind of priority) {
    const hit = calls.find((call) => call.kind === kind && call.model);
    if (hit) return hit.model;
  }
  return calls[0]?.model || FALLBACK_PROVIDER;
}

function groupLlmByTrace(calls: LlmCallRow[]): Map<string, LlmCallRow[]> {
  const map = new Map<string, LlmCallRow[]>();
  for (const call of calls) {
    if (!call.trace_id) continue;
    const list = map.get(call.trace_id) ?? [];
    list.push(call);
    map.set(call.trace_id, list);
  }
  for (const [key, list] of map) {
    list.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
    map.set(key, list);
  }
  return map;
}

function enrichRow(
  row: ActivityRow,
  llmByTrace: Map<string, LlmCallRow[]>,
  traceById: Map<string, GroupedTrace>,
  allLlmCalls: LlmCallRow[],
  traces: GroupedTrace[],
  _userLabels: Record<string, string>,
): ActivityRow {
  let traceId = row.traceId;
  let llmCalls = traceId ? llmByTrace.get(traceId) ?? [] : [];

  if (row.type === "chat" && row.id.startsWith("solve:")) {
    const solveId = row.id.slice("solve:".length);
    // row already built; re-derive trace link from traces list via stored question/time on row
    const pseudoSolve: SolveLogRow = {
      id: solveId,
      created_at: row.createdAt,
      user_id: row.userId,
      player_name: null,
      trace_id: row.traceId ?? null,
      game: row.game,
      platform: row.platform,
      question: row.question ?? row.summary,
      pipeline_type:
        typeof row.technical?.pipeline_type === "string" ? row.technical.pipeline_type : null,
      status: row.status === "error" ? "error" : "success",
      total_latency_ms: row.latencyMs,
    };
    traceId = resolveSolveTraceId(pseudoSolve, traces) ?? traceId;
    llmCalls = linkLlmCallsForSolve(pseudoSolve, allLlmCalls, traceId, traceStartMs(traceId, traces)) as LlmCallRow[];
  } else if (row.type === "guide_ingest" && row.id.startsWith("ingest:")) {
    const pseudoIngest: IngestLogRow = {
      id: row.id.slice("ingest:".length),
      created_at: row.createdAt,
      user_id: row.userId,
      game: row.game,
      platform: row.platform,
      url: row.question ?? row.summary,
      status: row.status === "error" ? "error" : "success",
      latency_ms: row.latencyMs,
      trace_id: row.traceId ?? null,
    };
    llmCalls = linkLlmCallsForIngest(pseudoIngest, allLlmCalls, traceId) as LlmCallRow[];
  } else if (traceId) {
    llmCalls = llmByTrace.get(traceId) ?? llmCalls;
  }

  const trace = traceId ? traceById.get(traceId) : undefined;
  const provider = llmCalls.length ? providerFromLlmCalls(llmCalls) : row.provider;
  const traceEvents = trace?.events;
  const technical = {
    ...row.technical,
    trace_event_count: trace?.rawEventCount,
    trace_latency_ms: trace?.totalLatencyMs,
  };

  return {
    ...row,
    traceId,
    provider,
    llmCalls,
    traceEvents,
    pipeline: buildActivityPipeline(traceEvents, technical, llmCalls),
    technical,
  };
}

export function solveLogToActivity(row: SolveLogRow): ActivityRow {
  return {
    id: `solve:${row.id}`,
    type: "chat",
    createdAt: row.created_at,
    status: row.status === "success" ? "success" : "error",
    userLabel: userLabel(row.user_id, row.player_name),
    userId: row.user_id,
    game: row.game,
    platform: row.platform,
    provider: FALLBACK_PROVIDER,
    service: pipelineService(row.pipeline_type),
    summary: row.question,
    question: row.question,
    answer: row.answer ?? (row.error_message ? `Error: ${row.error_message}` : null),
    traceId: row.trace_id ?? undefined,
    latencyMs: row.total_latency_ms,
    technical: {
      pipeline_type: row.pipeline_type,
      rewrite_latency_ms: row.rewrite_latency_ms,
      retrieval_latency_ms: row.retrieval_latency_ms,
      generation_latency_ms: row.generation_latency_ms,
      preferred_urls: row.preferred_urls,
      sources: row.sources,
      error_message: row.error_message,
    },
  };
}

export function ingestLogToActivity(row: IngestLogRow): ActivityRow {
  const pages = row.pages_indexed ?? 0;
  const missing = row.pages_missing ?? 0;
  const summary =
    missing > 0 ? `Indexed ${pages} pages (${missing} missing)` : `Indexed ${pages} page${pages === 1 ? "" : "s"}`;
  return {
    id: `ingest:${row.id}`,
    type: "guide_ingest",
    createdAt: row.created_at,
    status: row.status === "success" ? "success" : "error",
    userLabel: userLabel(row.user_id, row.player_name),
    userId: row.user_id,
    game: row.game,
    platform: row.platform,
    provider: FALLBACK_PROVIDER,
    service: "Guide ingest",
    summary: row.url,
    question: row.url,
    answer: row.status === "success" ? summary : row.error_message ?? "Ingest failed",
    traceId: row.trace_id ?? undefined,
    latencyMs: row.latency_ms,
    technical: {
      url: row.url,
      pages_indexed: row.pages_indexed,
      pages_missing: row.pages_missing,
      hub_warning: row.hub_warning,
      error_message: row.error_message,
    },
  };
}

function traceCategoryToType(category: GroupedTrace["category"]): ActivityType | null {
  if (category === "Checking") return "guide_check";
  if (category === "Upload") return "guide_upload";
  if (category === "Memory") return "player_memory";
  if (category === "Journey") return "player_journey";
  return null;
}

export function traceToActivity(trace: GroupedTrace): ActivityRow | null {
  const type = traceCategoryToType(trace.category);
  if (!type) return null;

  const status: ActivityStatus =
    trace.status === "Finished"
      ? trace.events.some((e) => e.event_type.includes("error"))
        ? "error"
        : "success"
      : "processing";

  const provider =
    type === "guide_check"
      ? "Tavily"
      : type === "player_memory" || type === "player_journey"
        ? "Replicate"
        : "Tavily Extract";
  const service =
    type === "guide_check"
      ? "Guide bundle check"
      : type === "player_memory"
        ? "Player memory"
        : type === "player_journey"
          ? "Player journey"
          : "Guide file upload";

  return {
    id: `trace:${trace.traceId}`,
    type,
    createdAt: trace.startTime,
    status,
    userLabel: userLabel(trace.userId, trace.userName),
    userId: trace.userId ?? null,
    game: trace.game ?? null,
    platform: trace.platform ?? null,
    provider,
    service,
    summary: trace.question ?? trace.traceId,
    question: trace.question ?? null,
    answer: trace.events.at(-1)?.message ?? null,
    traceId: trace.traceId,
    latencyMs: trace.totalLatencyMs,
    technical: {
      event_count: trace.rawEventCount,
      category: trace.category,
      pipeline_type:
        trace.category === "Memory"
          ? "memory"
          : trace.category === "Journey"
            ? "journal"
            : trace.pipelineType,
      generation_latency_ms:
        trace.events.find((e) => e.event_type === "memory_summarize_complete")?.latency_ms ??
        trace.events.find((e) => e.event_type === "memory_refresh_complete")?.latency_ms ??
        trace.events.find((e) => e.event_type === "journal_update_complete")?.latency_ms ??
        null,
    },
  };
}

export function mergeActivityRows(input: {
  solveLogs: SolveLogRow[];
  ingestLogs: IngestLogRow[];
  traces: GroupedTrace[];
  llmCalls: LlmCallRow[];
  userLabels?: Record<string, string>;
  userEmails?: Record<string, string>;
  limit?: number;
}): ActivityRow[] {
  const userLabels = input.userLabels ?? {};
  const userEmails = input.userEmails ?? {};
  const llmByTrace = groupLlmByTrace(input.llmCalls);
  const traceById = new Map(input.traces.map((trace) => [trace.traceId, trace]));
  const claimedTraceIds = new Set<string>();

  const rows: ActivityRow[] = [
    ...input.solveLogs.map((row) => {
      const traceId = resolveSolveTraceId(row, input.traces) ?? row.trace_id ?? undefined;
      if (traceId) claimedTraceIds.add(traceId);
      const tracePlayer = resolveTracePlayerName(traceId, input.traces);
      const base = solveLogToActivity({ ...row, trace_id: traceId ?? row.trace_id });
      base.userLabel = userLabel(
        row.user_id,
        row.player_name || tracePlayer,
        row.user_id ? userLabels[row.user_id] : null,
      );
      base.userEmail = row.user_id ? userEmails[row.user_id] ?? null : null;
      return enrichRow(base, llmByTrace, traceById, input.llmCalls, input.traces, userLabels);
    }),
    ...input.ingestLogs.map((row) => {
      if (row.trace_id) claimedTraceIds.add(row.trace_id);
      const base = ingestLogToActivity(row);
      base.userLabel = userLabel(row.user_id, row.player_name, row.user_id ? userLabels[row.user_id] : null);
      base.userEmail = row.user_id ? userEmails[row.user_id] ?? null : null;
      return enrichRow(base, llmByTrace, traceById, input.llmCalls, input.traces, userLabels);
    }),
    ...input.traces
      .filter((trace) => !claimedTraceIds.has(trace.traceId))
      .flatMap((trace) => {
        const row = traceToActivity(trace);
        return row ? [enrichRow(row, llmByTrace, traceById, input.llmCalls, input.traces, userLabels)] : [];
      }),
  ];

  rows.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  return rows.slice(0, input.limit ?? 500);
}

export const ACTIVITY_TYPE_LABELS: Record<ActivityType, string> = {
  chat: "Chat",
  guide_ingest: "Guide ingest",
  guide_check: "Guide check",
  guide_upload: "Guide upload",
  player_memory: "Player memory",
  player_journey: "Player journey",
};

export const LLM_KIND_LABELS: Record<string, string> = {
  rewrite: "Query rewrite",
  summarize: "Answer generation",
  censor: "Spoiler censor",
  memory_summarize: "Memory summarize",
  journal_synthesize: "Journal synthesize",
  embed_index: "Guide embed (index)",
  embed_query: "Guide embed (query)",
};

export function formatActivityWhen(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatLatency(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return "—";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export {
  ADMIN_DATE_RANGE_OPTIONS,
  DEFAULT_ADMIN_DATE_PRESET,
  dateRangeBounds,
  dateRangeForPreset,
  defaultDateFrom,
  todayDateInput,
  type AdminDateRangePreset,
} from "./admin-date-range";
