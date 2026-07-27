"use client";

import {
  ACTIVITY_TYPE_LABELS,
  formatActivityWhen,
  formatLatency,
  LLM_KIND_LABELS,
  type ActivityRow,
  type ActivityType,
  type LlmCallRow,
} from "@/lib/admin-activity";
import { formatApiSpendCompact } from "@/lib/admin-api-spend";
import type { ApiCostSummary } from "@/lib/admin-api-cost";
import { costFromSingleLlmCall } from "@/lib/admin-trace-event-cost";
import type { ActivityPipeline, PipelineCohere, PipelineRerank, PipelineSourceRow } from "@/lib/admin-pipeline";
import { TraceEventsTable } from "@/app/admin/trace-events-table";

function badgeClass(type: ActivityType): string {
  if (type === "chat") return "activity-badge activity-badge--chat";
  if (type === "guide_ingest") return "activity-badge activity-badge--ingest";
  if (type === "guide_check") return "activity-badge activity-badge--check";
  if (type === "player_memory") return "activity-badge activity-badge--memory";
  if (type === "player_journey") return "activity-badge activity-badge--journey";
  return "activity-badge activity-badge--upload";
}

function CollapsibleSection({
  title,
  count,
  defaultOpen = false,
  children,
}: {
  title: string;
  count?: number;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  return (
    <details className="pipeline-section" open={defaultOpen}>
      <summary className="pipeline-section-summary">
        <span>{title}</span>
        {count != null ? <span className="pipeline-section-count">{count}</span> : null}
      </summary>
      <div className="pipeline-section-body">{children}</div>
    </details>
  );
}

function SourcePanel({ source, index }: { source: PipelineSourceRow; index: number }) {
  const score =
    source.similarity != null
      ? `sim ${source.similarity.toFixed(3)}`
      : source.score != null
        ? `score ${source.score.toFixed(2)}`
        : null;
  return (
    <details className="llm-panel">
      <summary className="llm-panel-summary">
        <span className="llm-kind">#{index + 1}</span>
        <span className="llm-model">{source.title}</span>
        {score ? <span className="llm-meta">{score}</span> : null}
      </summary>
      <div className="llm-panel-body">
        {source.url ? (
          <div className="activity-block">
            <h3>URL</h3>
            <p className="activity-url">{source.url}</p>
          </div>
        ) : null}
        {source.preview ? (
          <div className="activity-block">
            <h3>Snippet sent to LLM</h3>
            <pre>{source.preview}</pre>
          </div>
        ) : (
          <p className="profile-hint">No crawled snippet stored for this result.</p>
        )}
      </div>
    </details>
  );
}

function LlmCallPanel({
  call,
  formatCost,
}: {
  call: LlmCallRow;
  formatCost: (usd: number | null) => string;
}) {
  const label = LLM_KIND_LABELS[call.kind] ?? call.kind;
  const costUsd = costFromSingleLlmCall(call);
  return (
    <details className="llm-panel">
      <summary className="llm-panel-summary">
        <span className="llm-kind">{label}</span>
        <span className="llm-model">{call.model}</span>
        <span className="llm-meta">
          {formatLatency(call.duration_ms)}
          {call.input_tokens != null ? ` · ${call.input_tokens} in` : ""}
          {call.output_tokens != null ? ` · ${call.output_tokens} out` : ""}
          {costUsd != null ? ` · ${formatCost(costUsd)}` : ""}
        </span>
      </summary>
      <div className="llm-panel-body">
        <div className="activity-block">
          <h3>System instruction</h3>
          <pre>{call.system_instruction || "(empty)"}</pre>
        </div>
        <div className="activity-block">
          <h3>Prompt</h3>
          <pre>{call.prompt || "(empty)"}</pre>
        </div>
        <div className="activity-block">
          <h3>Response</h3>
          <pre>{call.response || "(empty)"}</pre>
        </div>
      </div>
    </details>
  );
}

function RerankPanel({ rerank, chunkCount }: { rerank: PipelineRerank; chunkCount?: number }) {
  return (
    <div className="pipeline-kv">
      <span>
        <strong>Status</strong> {rerank.status}
      </span>
      {rerank.provider ? (
        <span>
          <strong>Provider</strong> {rerank.provider}
        </span>
      ) : null}
      {rerank.model ? (
        <span>
          <strong>Model</strong> {rerank.model}
        </span>
      ) : null}
      {chunkCount != null ? (
        <span>
          <strong>Chunks in</strong> {chunkCount}
        </span>
      ) : null}
      {rerank.topScore != null ? (
        <span>
          <strong>Top score</strong> {rerank.topScore.toFixed(3)}
        </span>
      ) : null}
      {rerank.relevant != null ? (
        <span>
          <strong>Relevant</strong> {rerank.relevant ? "yes" : "no"}
        </span>
      ) : null}
      {rerank.latencyMs != null ? (
        <span>
          <strong>Latency</strong> {formatLatency(rerank.latencyMs)}
        </span>
      ) : null}
      {rerank.message ? <p className="pipeline-note">{rerank.message}</p> : null}
    </div>
  );
}

function ApiSpendSection({
  spend,
  cost,
  formatCost,
  fxRateLabel,
}: {
  spend: NonNullable<ActivityPipeline["apiSpend"]>;
  cost?: ActivityPipeline["apiCost"];
  formatCost: (usd: number | null) => string;
  fxRateLabel?: string;
}) {
  const costByKey = new Map(cost?.lines.map((line) => [line.key, line]) ?? []);

  return (
    <CollapsibleSection title="API calls" count={spend.total} defaultOpen>
      <div className="api-spend-grid">
        {spend.lines.map((line) => {
          const priced = costByKey.get(line.key);
          return (
            <div key={line.key} className="api-spend-chip">
              <div className="api-spend-chip-top">
                <span className="api-spend-chip-label">{line.label}</span>
                <span className="api-spend-chip-value">{line.count}</span>
              </div>
              {priced?.costUsd != null ? (
                <div className="api-spend-chip-cost">
                  {formatCost(priced.costUsd)}
                  {priced.tokenNote ? <span className="api-spend-chip-tokens">{priced.tokenNote}</span> : null}
                </div>
              ) : (
                <div className="api-spend-chip-cost api-spend-chip-cost--muted">No token data</div>
              )}
            </div>
          );
        })}
        {cost ? (
          <div className="api-spend-chip api-spend-chip--total">
            <div className="api-spend-chip-top">
              <span className="api-spend-chip-label">Est. total</span>
              <span className="api-spend-chip-value">{formatCost(cost.knownTotalUsd)}</span>
            </div>
            {!cost.complete ? (
              <div className="api-spend-chip-cost api-spend-chip-cost--muted">Partial (Tavily/Cohere not priced yet)</div>
            ) : null}
          </div>
        ) : null}
      </div>
      <p className="profile-hint">
        Costs shown in IDR at today&apos;s rate{fxRateLabel ? ` (${fxRateLabel})` : ""}. Token-priced: Replicate Flash 2.5 and Sumopod embed.
      </p>
    </CollapsibleSection>
  );
}

function CohereSection({ cohere }: { cohere: PipelineCohere }) {
  return (
    <CollapsibleSection title="Cohere rerank" count={cohere.events.length} defaultOpen>
      <RerankPanel rerank={cohere} chunkCount={cohere.chunkCount} />
      {cohere.events.length ? (
        <div className="llm-panel-list">
          {cohere.events.map((event) => (
            <details key={`${event.created_at}-${event.event_type}`} className="llm-panel">
              <summary className="llm-panel-summary">
                <span className="llm-kind">{event.event_type.replace("rag_rerank_", "")}</span>
                <span className="llm-model">{event.message}</span>
                <span className="llm-meta">
                  {event.latency_ms != null ? formatLatency(event.latency_ms) : "—"}
                </span>
              </summary>
              <div className="llm-panel-body">
                <div className="activity-block">
                  <h3>Metadata</h3>
                  <pre>{event.metadata ? JSON.stringify(event.metadata, null, 2) : "{}"}</pre>
                </div>
              </div>
            </details>
          ))}
        </div>
      ) : null}
    </CollapsibleSection>
  );
}

function WebSearchSection({ web }: { web: NonNullable<ActivityPipeline["webSearch"]> }) {
  return (
    <CollapsibleSection title="Web search" count={web.sources.length} defaultOpen>
      <div className="pipeline-kv">
        {web.searchTopic ? (
          <span>
            <strong>Rewritten query</strong> {web.searchTopic}
          </span>
        ) : null}
        {web.queries.length > 0 ? (
          <span>
            <strong>Search queries</strong> {web.queries.join(" · ")}
          </span>
        ) : null}
        {web.latencyMs != null ? (
          <span>
            <strong>Latency</strong> {formatLatency(web.latencyMs)}
          </span>
        ) : null}
      </div>
      {web.sources.length ? (
        <div className="llm-panel-list">
          {web.sources.map((source, index) => (
            <SourcePanel key={`${source.url}-${index}`} source={source} index={index} />
          ))}
        </div>
      ) : (
        <p className="profile-hint">No web results were used for this turn.</p>
      )}
    </CollapsibleSection>
  );
}

function RagSection({ rag }: { rag: NonNullable<ActivityPipeline["rag"]> }) {
  return (
    <CollapsibleSection title="Preferred guide RAG" count={rag.chunks.length} defaultOpen>
      <div className="pipeline-kv">
        {rag.hit != null ? (
          <span>
            <strong>Guide hit</strong>{" "}
            <span className={rag.hit ? "pipeline-hit-yes" : "pipeline-hit-no"}>{rag.hit ? "yes" : "no"}</span>
          </span>
        ) : null}
        {rag.topSimilarity != null ? (
          <span>
            <strong>Top similarity</strong> {rag.topSimilarity.toFixed(3)}
            {rag.threshold != null ? ` (threshold ${rag.threshold})` : ""}
          </span>
        ) : null}
        {rag.matchCount != null ? (
          <span>
            <strong>Chunks retrieved</strong> {rag.matchCount}
          </span>
        ) : null}
        {rag.reranked != null ? (
          <span>
            <strong>Reranked</strong> {rag.reranked ? "yes" : "no"}
          </span>
        ) : null}
        {rag.embedQuery ? (
          <span>
            <strong>Embed query</strong> {rag.embedQuery}
          </span>
        ) : null}
      </div>
      {rag.chunks.length ? (
        <div className="llm-panel-list">
          {rag.chunks.map((source, index) => (
            <SourcePanel key={`${source.url}-${index}`} source={source} index={index} />
          ))}
        </div>
      ) : (
        <p className="profile-hint">No RAG chunk text logged for this turn yet.</p>
      )}
    </CollapsibleSection>
  );
}

type ActivityCardProps = {
  row: ActivityRow;
  onCopyTrace: (traceId: string) => void;
  copiedTraceId: string | null;
  formatCost: (usd: number | null) => string;
  formatCostCompact: (summary: ApiCostSummary) => string;
  fxRateLabel?: string;
};

export function ActivityCard({
  row,
  onCopyTrace,
  copiedTraceId,
  formatCost,
  formatCostCompact,
  fxRateLabel,
}: ActivityCardProps) {
  const gameLine = [row.game, row.platform].filter(Boolean).join(" · ");
  const pipeline = row.pipeline;
  const technicalJson = pipeline
    ? {
        pipeline_type: pipeline.pipelineType,
        latencies: pipeline.latencies,
        ...pipeline.technicalExtras,
      }
    : row.technical;

  return (
    <details className={`activity-card activity-card--${row.status}`} id={row.traceId}>
      <summary className="activity-summary">
        <div className="activity-top">
          <span className={badgeClass(row.type)}>{ACTIVITY_TYPE_LABELS[row.type]}</span>
          <span className={`activity-status activity-status--${row.status}`}>{row.status}</span>
          <span className="activity-when">{formatActivityWhen(row.createdAt)}</span>
        </div>
        <p className="activity-title">{row.summary}</p>
        <div className="activity-meta">
          <span>
            <strong>User</strong> {row.userLabel}
          </span>
          {gameLine ? (
            <span>
              <strong>Game</strong> {gameLine}
            </span>
          ) : null}
          <span>
            <strong>Service</strong> {row.service}
          </span>
          <span>
            <strong>Model</strong> {row.provider}
          </span>
          <span>
            <strong>Latency</strong> {formatLatency(row.latencyMs)}
          </span>
        </div>
        <div className="activity-meta-bar">
          <span className="activity-meta-bar-start">
            {row.traceId ? (
              <>
                <strong>Trace</strong>{" "}
                <button
                  type="button"
                  className="activity-trace-btn"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    onCopyTrace(row.traceId!);
                  }}
                >
                  {copiedTraceId === row.traceId ? "Copied" : row.traceId.slice(0, 8)}
                </button>
              </>
            ) : (
              <span className="profile-hint">No trace linked</span>
            )}
          </span>
          <span className="activity-meta-bar-end">
            {pipeline?.apiSpend ? (
              <span className="activity-spend-compact">
                <strong>API</strong> {formatApiSpendCompact(pipeline.apiSpend)}
              </span>
            ) : null}
            {pipeline?.apiCost ? (
              <>
                <span className="activity-spend-compact">
                  <strong>Est.</strong> {formatCostCompact(pipeline.apiCost)}
                </span>
                <span className="activity-spend-compact activity-spend-total">
                  <strong>Total</strong> {formatCost(pipeline.apiCost.knownTotalUsd)}
                </span>
              </>
            ) : null}
          </span>
        </div>
      </summary>
      <div className="activity-body">
        {row.question ? (
          <div className="activity-block">
            <h3>Question</h3>
            <p>{row.question}</p>
          </div>
        ) : null}
        {row.answer ? (
          <div className="activity-block">
            <h3>{row.type === "chat" ? "Answer" : "Result"}</h3>
            <p>{row.answer}</p>
          </div>
        ) : null}

        {pipeline?.apiSpend ? (
          <ApiSpendSection
            spend={pipeline.apiSpend}
            cost={pipeline.apiCost}
            formatCost={formatCost}
            fxRateLabel={fxRateLabel}
          />
        ) : null}

        {row.llmCalls && row.llmCalls.length > 0 ? (
          <CollapsibleSection title="LLM calls" count={row.llmCalls.length} defaultOpen>
            <div className="llm-panel-list">
              {row.llmCalls.map((call) => (
                <LlmCallPanel key={call.id} call={call} formatCost={formatCost} />
              ))}
            </div>
          </CollapsibleSection>
        ) : null}

        {pipeline?.webSearch ? <WebSearchSection web={pipeline.webSearch} /> : null}
        {pipeline?.cohere ? <CohereSection cohere={pipeline.cohere} /> : null}
        {pipeline?.rag ? <RagSection rag={pipeline.rag} /> : null}

        {technicalJson && Object.keys(technicalJson).length > 0 ? (
          <CollapsibleSection title="Technical details">
            <pre>{JSON.stringify(technicalJson, null, 2)}</pre>
          </CollapsibleSection>
        ) : null}

        {row.traceEvents && row.traceEvents.length > 0 ? (
          <CollapsibleSection title="Raw trace events" count={row.traceEvents.length}>
            <TraceEventsTable events={row.traceEvents} />
          </CollapsibleSection>
        ) : null}
      </div>
    </details>
  );
}
