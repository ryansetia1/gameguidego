export type TraceEventRow = {
  id?: string;
  trace_id: string;
  created_at: string;
  event_type: string;
  message: string;
  latency_ms?: number | null;
  metadata?: Record<string, unknown> | null;
};

export type GroupedTrace = {
  traceId: string;
  events: TraceEventRow[];
  rawEventCount: number;
  startTime: string;
  totalLatencyMs: number;
  game?: string;
  platform?: string;
  question?: string;
  category: "Chat" | "Upload" | "Checking" | "Ingest" | "Memory" | "Journey";
  status: "Finished" | "New" | "Processing";
  statusColor: string;
  userName?: string;
  userId?: string;
  pipelineType?: string;
  answerPreview?: string;
};

function metaString(meta: Record<string, unknown> | null | undefined, key: string): string | undefined {
  const value = meta?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function formatReplicateMessage(status: string | undefined, fallback: string): string {
  if (status) return `Replicate prediction: ${status}`;
  const match = fallback.match(/status:\s*(\w+)/i);
  return match ? `Replicate prediction: ${match[1]}` : fallback;
}

const PHASE_TAIL: Record<string, { label: string; phaseType: string }> = {
  rewrite_complete: { label: "Query rewrite", phaseType: "rewrite" },
  generation_complete: { label: "Answer generation", phaseType: "summarize" },
  censor_complete: { label: "Spoiler censor", phaseType: "censor" },
};

const PHASE_LEAD = new Set(["solve_start", "censor_start"]);

function compactReplicateStatus(events: TraceEventRow[]): TraceEventRow[] {
  const mergedEvents: TraceEventRow[] = [];
  let currentRep: TraceEventRow | null = null;

  for (const event of events) {
    if (event.event_type === "replicate_status") {
      const status = metaString(event.metadata, "status");
      currentRep = {
        ...event,
        message: formatReplicateMessage(status, event.message),
        metadata: { ...event.metadata, status, compactReplicate: true },
      };
      continue;
    }
    if (currentRep) {
      mergedEvents.push(currentRep);
      currentRep = null;
    }
    mergedEvents.push(event);
  }
  if (currentRep) mergedEvents.push(currentRep);
  return mergedEvents;
}

function buildPhaseRow(
  events: TraceEventRow[],
  phase: { label: string; phaseType: string },
  done: boolean,
  eventType: "llm_phase" | "trace_phase" = "llm_phase",
): TraceEventRow {
  const first = events[0]!;
  const last = events[events.length - 1]!;
  const status = metaString(last.metadata, "status") ?? metaString(first.metadata, "status");
  let message = phase.label;
  if (done && last.message && last !== first) message = `${phase.label}: ${last.message}`;
  else if (!done && status) message = `${phase.label}: ${status}`;
  else if (events.length === 1) message = last.message;

  const latency = events.reduce((sum, event) => sum + (event.latency_ms ?? 0), 0);

  return {
    trace_id: first.trace_id,
    created_at: last.created_at,
    event_type: eventType,
    message,
    latency_ms: latency > 0 ? latency : (last.latency_ms ?? null),
    metadata: {
      ...first.metadata,
      ...last.metadata,
      compactPhase: true,
      phaseType: phase.phaseType,
      phaseLabel: phase.label,
      phaseComplete: done,
      status,
      stepCount: events.length,
    },
  };
}

function buildLlmPhaseRow(
  lead: TraceEventRow | null,
  rep: TraceEventRow,
  tail: TraceEventRow | null,
  phase: { label: string; phaseType: string },
): TraceEventRow {
  const block = [rep, ...(tail ? [tail] : [])];
  if (lead) block.unshift(lead);
  return buildPhaseRow(block, phase, Boolean(tail), "llm_phase");
}

type PairRule = {
  start: string;
  ends: string[];
  middle?: Set<string>;
  phaseType: string;
  label: string;
};

const TRACE_PAIR_RULES: PairRule[] = [
  {
    start: "tavily_search_start",
    ends: ["tavily_search_end"],
    phaseType: "tavily_search",
    label: "Tavily search",
  },
  {
    start: "tavily_extract_start",
    ends: ["tavily_extract_end"],
    phaseType: "tavily_extract",
    label: "Tavily extract",
  },
  {
    start: "rag_rerank_start",
    ends: ["rag_rerank_ok", "rag_rerank_error"],
    phaseType: "cohere_rerank",
    label: "Cohere rerank",
  },
  {
    start: "embed_query_start",
    ends: ["embed_query_end"],
    middle: new Set(["embed_texts_start", "embed_texts_end"]),
    phaseType: "rag_embed",
    label: "RAG query embed",
  },
];

function compactTracePairs(events: TraceEventRow[]): TraceEventRow[] {
  const out: TraceEventRow[] = [];
  let i = 0;

  while (i < events.length) {
    const event = events[i]!;
    const rule = TRACE_PAIR_RULES.find((row) => row.start === event.event_type);
    if (!rule) {
      if (event.event_type === "embed_query_cache_hit") {
        out.push(
          buildPhaseRow([event], { phaseType: "rag_embed", label: "RAG query embed" }, true, "trace_phase"),
        );
        i++;
        continue;
      }
      out.push(event);
      i++;
      continue;
    }

    const block: TraceEventRow[] = [event];
    i++;
    let done = false;

    while (i < events.length) {
      const next = events[i]!;
      if (rule.ends.includes(next.event_type)) {
        block.push(next);
        done = true;
        i++;
        break;
      }
      if (rule.middle?.has(next.event_type)) {
        block.push(next);
        i++;
        continue;
      }
      break;
    }

    out.push(buildPhaseRow(block, { phaseType: rule.phaseType, label: rule.label }, done, "trace_phase"));
  }

  return out;
}

function mergeWebSearchBlock(events: TraceEventRow[]): TraceEventRow[] {
  const out: TraceEventRow[] = [];
  let i = 0;

  while (i < events.length) {
    const event = events[i]!;
    if (event.event_type !== "web_search_start") {
      out.push(event);
      i++;
      continue;
    }

    const block: TraceEventRow[] = [event];
    i++;
    while (i < events.length && events[i]!.event_type !== "web_search_complete") {
      block.push(events[i]!);
      i++;
    }

    const tail = events[i];
    if (tail?.event_type === "web_search_complete") {
      block.push(tail);
      i++;
    }

    out.push(
      buildPhaseRow(
        block,
        { phaseType: "web_search", label: "Web search" },
        tail?.event_type === "web_search_complete",
        "trace_phase",
      ),
    );
  }

  return out;
}

function compactRagRetrieve(events: TraceEventRow[]): TraceEventRow[] {
  const out: TraceEventRow[] = [];
  let i = 0;

  while (i < events.length) {
    const event = events[i]!;
    if (event.event_type === "rag_db_check") {
      const next = events[i + 1];
      if (next?.event_type === "rag_similarity_score") {
        out.push(
          buildPhaseRow(
            [event, next],
            { phaseType: "rag_retrieve", label: "RAG retrieval" },
            true,
            "trace_phase",
          ),
        );
        i += 2;
        continue;
      }
      out.push(buildPhaseRow([event], { phaseType: "rag_retrieve", label: "RAG retrieval" }, true, "trace_phase"));
      i++;
      continue;
    }
    if (event.event_type === "rag_similarity_score") {
      out.push(buildPhaseRow([event], { phaseType: "rag_retrieve", label: "RAG retrieval" }, true, "trace_phase"));
      i++;
      continue;
    }
    out.push(event);
    i++;
  }

  return out;
}

function mergeReplicatePhases(events: TraceEventRow[]): TraceEventRow[] {
  const out: TraceEventRow[] = [];
  let i = 0;

  while (i < events.length) {
    let j = i;
    let lead: TraceEventRow | null = null;

    if (PHASE_LEAD.has(events[j]?.event_type ?? "")) {
      lead = events[j]!;
      j++;
    }

    const rep = events[j];
    if (rep?.event_type !== "replicate_status") {
      out.push(events[i]!);
      i++;
      continue;
    }

    const tail = events[j + 1];
    const phase = tail ? PHASE_TAIL[tail.event_type] : undefined;

    if (phase) {
      out.push(buildLlmPhaseRow(lead, rep, tail, phase));
      i = j + 2;
      continue;
    }

    if (lead) {
      const inProgressPhase =
        lead.event_type === "solve_start"
          ? { label: "Query rewrite", phaseType: "rewrite" }
          : { label: "Spoiler censor", phaseType: "censor" };
      out.push(buildLlmPhaseRow(lead, rep, null, inProgressPhase));
      i = j + 1;
      continue;
    }

    out.push(rep);
    i = j + 1;
  }

  return out;
}

function compactMemorySummarize(events: TraceEventRow[]): TraceEventRow[] {
  const out: TraceEventRow[] = [];
  let i = 0;

  while (i < events.length) {
    const event = events[i]!;
    if (event.event_type !== "memory_summarize_start" && event.event_type !== "memory_llm_start") {
      out.push(event);
      i++;
      continue;
    }

    const block: TraceEventRow[] = [event];
    i++;
    while (
      i < events.length &&
      events[i]!.event_type !== "memory_summarize_complete" &&
      events[i]!.event_type !== "memory_summarize_error"
    ) {
      block.push(events[i]!);
      i++;
    }

    const tail = events[i];
    if (tail?.event_type === "memory_summarize_complete" || tail?.event_type === "memory_summarize_error") {
      block.push(tail);
      i++;
    }

    out.push(
      buildPhaseRow(
        block,
        { phaseType: "memory_summarize", label: "Memory summarize" },
        tail?.event_type === "memory_summarize_complete",
        "trace_phase",
      ),
    );
  }

  return out;
}

function compactJournalBand(events: TraceEventRow[]): TraceEventRow[] {
  const out: TraceEventRow[] = [];
  let i = 0;

  while (i < events.length) {
    const event = events[i]!;

    if (event.event_type === "journal_rag_retrieve" || event.event_type === "journal_rag_skipped") {
      out.push(
        buildPhaseRow(
          [event],
          {
            phaseType: "journal_rag",
            label: event.event_type === "journal_rag_skipped" ? "Journal RAG (skipped)" : "Journal RAG",
          },
          true,
          "trace_phase",
        ),
      );
      i++;
      continue;
    }

    if (event.event_type === "journal_update_skipped") {
      out.push(
        buildPhaseRow(
          [event],
          { phaseType: "journal_update", label: "Journal update" },
          true,
          "trace_phase",
        ),
      );
      i++;
      continue;
    }

    if (event.event_type !== "journal_update_start") {
      out.push(event);
      i++;
      continue;
    }

    const block: TraceEventRow[] = [event];
    i++;
    while (
      i < events.length &&
      events[i]!.event_type !== "journal_update_complete" &&
      events[i]!.event_type !== "journal_update_error"
    ) {
      block.push(events[i]!);
      i++;
    }

    const tail = events[i];
    if (tail?.event_type === "journal_update_complete" || tail?.event_type === "journal_update_error") {
      block.push(tail);
      i++;
    }

    out.push(
      buildPhaseRow(
        block,
        { phaseType: "journal_update", label: "Journal update" },
        tail?.event_type === "journal_update_complete",
        "trace_phase",
      ),
    );
  }

  return out;
}

/** Collapse replicate polls, merge LLM phases, then compact Tavily/RAG/rerank steps. */
export function compactTraceEvents(events: TraceEventRow[]): TraceEventRow[] {
  const llmCompact = mergeReplicatePhases(compactReplicateStatus(events));
  const paired = compactTracePairs(llmCompact);
  const web = mergeWebSearchBlock(paired);
  const rag = compactRagRetrieve(web);
  return compactJournalBand(compactMemorySummarize(rag));
}

/** Per-trace compact, then newest-first for the live feed. */
export function compactTraceEventsForLiveFeed(events: TraceEventRow[], limit = 60): TraceEventRow[] {
  const byTrace = new Map<string, TraceEventRow[]>();
  for (const event of events) {
    const list = byTrace.get(event.trace_id) ?? [];
    list.push(event);
    byTrace.set(event.trace_id, list);
  }

  const groups: { events: TraceEventRow[]; latest: number }[] = [];
  for (const traceEvents of byTrace.values()) {
    const sorted = [...traceEvents].sort(
      (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
    );
    const compacted = compactTraceEvents(sorted);
    const latest = Math.max(...compacted.map((e) => new Date(e.created_at).getTime()));
    groups.push({ events: compacted, latest });
  }

  groups.sort((a, b) => b.latest - a.latest);

  const clustered: TraceEventRow[] = [];
  for (const group of groups) {
    const sortedDesc = [...group.events].sort(
      (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
    );
    clustered.push(...sortedDesc);
  }

  return clustered.slice(0, limit);
}

export function isReplicateInProgress(event: TraceEventRow): boolean {
  if (event.event_type === "llm_phase") {
    if (event.metadata?.phaseComplete === true) return false;
    const status = metaString(event.metadata, "status");
    if (status === "starting" || status === "processing") return true;
    return event.metadata?.phaseComplete === false;
  }
  if (event.event_type === "trace_phase") {
    if (event.metadata?.phaseComplete === true) return false;
    // Fast HTTP steps (Cohere/Tavily/embed) finish in one shot — no Replicate-style polling.
    const phase = metaString(event.metadata, "phaseType");
    if (phase === "web_search") return event.metadata?.phaseComplete === false;
    return false;
  }
  if (event.event_type !== "replicate_status") return false;
  const status = metaString(event.metadata, "status");
  return status === "starting" || status === "processing";
}

export function traceEventTypeLabel(event: TraceEventRow): string {
  if (event.event_type === "llm_phase" || event.event_type === "trace_phase") {
    const phase = metaString(event.metadata, "phaseType");
    return phase ?? event.event_type;
  }
  return event.event_type;
}

export function groupTraceEvents(traces: TraceEventRow[]): GroupedTrace[] {
  const grouped = new Map<string, TraceEventRow[]>();
  for (const row of traces) {
    if (!grouped.has(row.trace_id)) grouped.set(row.trace_id, []);
    grouped.get(row.trace_id)!.push(row);
  }

  const groupedTraces = Array.from(grouped.entries()).map(([traceId, rawEvents]) => {
    const events = [...rawEvents].sort(
      (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
    );
    const mergedEvents = compactTraceEvents(events);

    const solveStart = events.find((e) => e.event_type === "solve_start");
    const uploadStart = events.find((e) => e.event_type === "upload_start");
    const discoveryStart = events.find((e) => e.event_type === "discovery_start");
    const ingestStart = events.find((e) => e.event_type === "ingest_start");
    const memoryStart = events.find((e) => e.event_type === "memory_refresh_start");
    const journalStart = events.find(
      (e) => e.event_type === "journal_update_start" || e.event_type === "journal_update_skipped",
    );
    const journalOnly =
      !solveStart &&
      !uploadStart &&
      !discoveryStart &&
      !ingestStart &&
      !memoryStart &&
      events.some((e) => e.event_type.startsWith("journal_"));

    const game =
      metaString(solveStart?.metadata, "game") ||
      metaString(uploadStart?.metadata, "game") ||
      metaString(ingestStart?.metadata, "game") ||
      metaString(journalStart?.metadata, "game");
    const platform =
      metaString(solveStart?.metadata, "platform") ||
      metaString(ingestStart?.metadata, "platform") ||
      metaString(journalStart?.metadata, "platform");
    const question =
      metaString(solveStart?.metadata, "question") ||
      (uploadStart?.metadata?.filename ? `Uploading: ${uploadStart.metadata.filename}` : undefined) ||
      (discoveryStart?.metadata?.url ? `Checking: ${discoveryStart.metadata.url}` : undefined) ||
      (ingestStart ? "Ingesting guides" : undefined) ||
      (memoryStart
        ? `Memory refresh (${metaString(memoryStart.metadata, "trigger") ?? "auto"})`
        : undefined) ||
      (journalStart
        ? `Journal update (${metaString(journalStart.metadata, "trigger") ?? "auto"})`
        : journalOnly
          ? "Journal update"
          : undefined);

    const category: GroupedTrace["category"] = memoryStart
      ? "Memory"
      : journalOnly
        ? "Journey"
        : uploadStart
          ? "Upload"
          : discoveryStart
            ? "Checking"
            : ingestStart
              ? "Ingest"
              : "Chat";

    const isFinished = events.some(
      (e) =>
        e.event_type === "generation_complete" ||
        e.event_type === "upload_complete" ||
        e.event_type === "error" ||
        e.event_type === "solve_error" ||
        e.event_type === "upload_error" ||
        e.event_type === "discovery_complete" ||
        e.event_type === "discovery_error" ||
        e.event_type === "ingest_url_complete" ||
        e.event_type === "ingest_url_error" ||
        e.event_type === "memory_refresh_complete" ||
        e.event_type === "memory_refresh_skipped" ||
        e.event_type === "memory_refresh_error" ||
        e.event_type === "journal_update_complete" ||
        e.event_type === "journal_update_skipped" ||
        e.event_type === "journal_update_error",
    );
    const isNew = !isFinished && events.length <= 3;
    const status: GroupedTrace["status"] = isFinished ? "Finished" : isNew ? "New" : "Processing";
    const statusColor = isFinished ? "var(--accent)" : isNew ? "var(--action)" : "var(--warn)";

    const retrieval = events.find((e) => e.event_type === "retrieval_complete");
    const pipelineType = metaString(retrieval?.metadata, "pipelineType");

    return {
      traceId,
      events: mergedEvents,
      rawEventCount: events.length,
      startTime: events[0]?.created_at ?? new Date().toISOString(),
      totalLatencyMs: events.reduce((sum, e) => sum + (e.latency_ms || 0), 0),
      game,
      platform,
      question,
      category,
      status,
      statusColor,
      userName:
        metaString(solveStart?.metadata, "playerName") ||
        metaString(uploadStart?.metadata, "playerName") ||
        metaString(ingestStart?.metadata, "playerName"),
      userId:
        metaString(solveStart?.metadata, "userId") ||
        metaString(uploadStart?.metadata, "userId") ||
        metaString(ingestStart?.metadata, "userId") ||
        metaString(memoryStart?.metadata, "userId") ||
        metaString(journalStart?.metadata, "userId"),
      pipelineType,
    };
  });

  groupedTraces.sort((a, b) => new Date(b.startTime).getTime() - new Date(a.startTime).getTime());
  return groupedTraces;
}
