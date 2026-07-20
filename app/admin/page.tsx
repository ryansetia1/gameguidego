"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { User } from "@supabase/supabase-js";
import { IconArrowLeft } from "@/app/icons";
import { getSupabase } from "@/lib/supabase";

export const dynamic = "force-dynamic";

export default function AdminPage() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [traces, setTraces] = useState<any[]>([]);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  useEffect(() => {
    const supabase = getSupabase();
    if (!supabase) {
      setErrorMsg("Supabase client not configured");
      setLoading(false);
      return;
    }

    let mounted = true;
    let channel: any = null;

    async function checkAuthAndLoadData() {
      const { data: { session } } = await supabase!.auth.getSession();
      
      if (!mounted) return;
      
      const currentUser = session?.user ?? null;
      setUser(currentUser);

      if (currentUser?.email === "ryansetiawan.works@gmail.com") {
        // Fetch initial data
        const { data, error } = await supabase!
          .from("trace_events")
          .select("trace_id, created_at, event_type, message, latency_ms, metadata")
          .order("created_at", { ascending: false })
          .limit(500);

        if (error) {
          setErrorMsg(error.message);
        } else if (data && mounted) {
          setTraces(data);
          
          // Subscribe to real-time changes
          channel = supabase!.channel("admin-trace-events")
            .on(
              "postgres_changes",
              { event: "*", schema: "public", table: "trace_events" },
              (payload) => {
                if (payload.eventType === "INSERT") {
                  setTraces((prev) => [payload.new, ...prev].slice(0, 500));
                } else if (payload.eventType === "DELETE") {
                  setTraces((prev) => prev.filter((t) => t.id !== payload.old.id));
                }
              }
            )
            .subscribe();
        }
      }
      
      setLoading(false);
    }

    void checkAuthAndLoadData();

    // Listen for auth state changes
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null);
    });

    return () => {
      mounted = false;
      sub.subscription.unsubscribe();
      if (channel) {
        supabase.removeChannel(channel);
      }
    };
  }, []);

  if (loading) {
    return (
      <main className="profile-page-shell">
        <nav className="nav" aria-label="Brand">
          <div className="nav-left">
            <Link className="profile-back icon-inline" href="/">
              <IconArrowLeft /> Home
            </Link>
          </div>
        </nav>
        <section className="profile-page" style={{ maxWidth: '1000px', margin: '0 auto', padding: '0 20px', width: '100%' }}>
          <p className="profile-hint" style={{ textAlign: "center", marginTop: "2rem" }}>
            Loading dashboard...
          </p>
        </section>
      </main>
    );
  }

  if (!user || user.email !== "ryansetiawan.works@gmail.com") {
    return (
      <main className="profile-page-shell">
        <nav className="nav" aria-label="Brand">
          <div className="nav-left">
            <Link className="profile-back icon-inline" href="/">
              <IconArrowLeft /> Home
            </Link>
          </div>
        </nav>
        <section className="profile-page">
          <div className="profile-card">
            <h1>Admin Access</h1>
            <p className="profile-hint">
              {user 
                ? "Your account does not have permission to view the trace dashboard."
                : "Please sign in with the admin account to view traces."
              }
            </p>
            {!user && (
              <Link href="/profile" className="nav-button" style={{ display: "inline-block", textAlign: "center" }}>
                Go to Profile to Sign In
              </Link>
            )}
          </div>
        </section>
      </main>
    );
  }

  // Group traces for display
  const grouped = new Map<string, any[]>();
  for (const row of traces) {
    if (!grouped.has(row.trace_id)) {
      grouped.set(row.trace_id, []);
    }
    grouped.get(row.trace_id)!.push(row);
  }
  
  const groupedTraces = Array.from(grouped.entries()).map(([traceId, rawEvents]) => {
    const events = [...rawEvents].sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
    
    const mergedEvents = [];
    let currentRep: any = null;
    let repCount = 0;
    
    for (const ev of events) {
      if (ev.event_type === "replicate_status") {
        if (!currentRep) {
          currentRep = { ...ev };
          repCount = 1;
        } else if (currentRep.message === ev.message) {
          repCount++;
        } else {
          if (repCount > 1) currentRep.message += ` (x${repCount})`;
          mergedEvents.push(currentRep);
          currentRep = { ...ev };
          repCount = 1;
        }
      } else {
        if (currentRep) {
          if (repCount > 1) currentRep.message += ` (x${repCount})`;
          mergedEvents.push(currentRep);
          currentRep = null;
          repCount = 0;
        }
        mergedEvents.push(ev);
      }
    }
    if (currentRep) {
      if (repCount > 1) currentRep.message += ` (x${repCount})`;
      mergedEvents.push(currentRep);
    }
    
    const solveStart = events.find(e => e.event_type === "solve_start");
    const game = solveStart?.metadata?.game;
    const question = solveStart?.metadata?.question;
    
    const isFinished = events.some(e => 
      e.event_type === "generation_complete" || 
      e.event_type === "error" || 
      e.event_type === "solve_error"
    );
    const isNew = !isFinished && events.length <= 3;
    const status = isFinished ? "Finished" : isNew ? "New" : "Processing";
    const statusColor = isFinished ? "var(--accent)" : isNew ? "var(--action)" : "var(--warn)";

    return {
      traceId,
      events: mergedEvents,
      rawEventCount: events.length,
      startTime: events[0]?.created_at,
      totalLatencyMs: events.reduce((sum, e) => sum + (e.latency_ms || 0), 0),
      game,
      question,
      status,
      statusColor
    };
  });
  groupedTraces.sort((a, b) => new Date(b.startTime).getTime() - new Date(a.startTime).getTime());

  const handleCopy = async (e: React.MouseEvent, text: string) => {
    e.preventDefault();
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(text);
      setTimeout(() => setCopiedId(null), 2000);
    } catch (err) {}
  };

  const handleDelete = async (e: React.MouseEvent, traceId: string) => {
    e.preventDefault();
    e.stopPropagation();
    if (!confirm("Delete all events for this trace?")) return;
    
    const supabase = getSupabase();
    if (!supabase) return;

    // We do NOT use optimistic UI here anymore because RLS might block it.
    // We wait for the DB response, and if successful, we let the realtime 
    // subscription or manual state update handle it.
    const { error } = await supabase.from("trace_events").delete().eq("trace_id", traceId);
    if (error) {
      alert("Failed to delete trace: " + error.message);
    } else {
      // Fallback state update in case realtime is slow/disconnected
      setTraces(prev => prev.filter(t => t.trace_id !== traceId));
    }
  };

  return (
    <main className="profile-page-shell">
      <nav className="nav" aria-label="Brand">
        <div className="nav-left">
          <Link className="profile-back icon-inline" href="/">
            <IconArrowLeft /> Home
          </Link>
        </div>
        <div className="nav-actions">
          <span className="profile-hint" style={{ marginRight: '1rem', fontSize: '0.8rem' }}>
            <span style={{ display: 'inline-block', width: '8px', height: '8px', background: 'var(--signal)', borderRadius: '50%', marginRight: '6px' }}></span>
            Real-time Active
          </span>
        </div>
      </nav>

      <section className="profile-page" style={{ maxWidth: '1000px', margin: '0 auto', padding: '0 20px', width: '100%' }}>
        <div className="profile-card" style={{ maxWidth: '100%' }}>
          <h1>Trace Dashboard</h1>
          <p className="profile-hint">Granular backend observability</p>

          {errorMsg && (
            <p className="profile-error">Error loading traces: {errorMsg}</p>
          )}

          <div className="trace-list">
            {groupedTraces.length === 0 && !errorMsg && (
              <p className="profile-hint" style={{ textAlign: 'center', marginTop: '2rem' }}>
                No traces found in the database.
              </p>
            )}

            {groupedTraces.map((trace) => (
              <details key={trace.traceId} className={`trace-details status-${trace.status.toLowerCase()}`}>
                <summary className="trace-summary" style={{ position: 'relative', overflow: 'hidden' }}>
                  <div style={{
                    position: 'absolute',
                    bottom: 0,
                    left: 0,
                    height: '3px',
                    background: trace.statusColor,
                    width: trace.status === 'Finished' ? '100%' : '60%',
                    opacity: 0.8,
                    animation: trace.status === 'Processing' ? 'pulse 2s infinite' : 'none'
                  }}></div>
                  <div className="trace-header">
                    <span className="trace-indicator">▶</span>
                    <div style={{ flex: 1 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <div className="trace-id">{trace.traceId}</div>
                        <span style={{ 
                          fontSize: '0.65rem', 
                          padding: '2px 6px', 
                          borderRadius: '4px', 
                          background: trace.statusColor, 
                          color: '#fff',
                          fontWeight: 'bold',
                          textTransform: 'uppercase'
                        }}>{trace.status}</span>
                      </div>
                      
                      {trace.game && trace.question && (
                        <div style={{ fontSize: '0.85rem', color: 'var(--ink)', margin: '4px 0', fontWeight: 500 }}>
                          <span style={{ color: 'var(--action)', fontWeight: 600 }}>{trace.game}</span>: {trace.question}
                        </div>
                      )}
                      
                      <div className="trace-meta">
                        {new Date(trace.startTime).toLocaleString()} • {trace.rawEventCount} events • {trace.totalLatencyMs}ms total
                      </div>
                    </div>
                    <div className="trace-actions" style={{ display: 'flex', gap: '8px' }}>
                      <button 
                        onClick={(e) => handleCopy(e, trace.traceId)}
                        className="nav-button"
                        style={{ padding: '4px 8px', fontSize: '0.75rem', minWidth: 'auto', minHeight: 'auto', background: 'var(--paper)', border: '1px solid var(--line)', color: 'var(--ink)' }}
                        title="Copy Trace ID"
                      >
                        {copiedId === trace.traceId ? "Copied!" : "Copy ID"}
                      </button>
                      <button 
                        onClick={(e) => handleDelete(e, trace.traceId)}
                        className="nav-button"
                        style={{ padding: '4px 8px', fontSize: '0.75rem', minWidth: 'auto', minHeight: 'auto', background: '#ffebee', border: '1px solid #ffcdd2', color: '#c62828' }}
                        title="Delete Trace"
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                </summary>
                <div className="trace-table-container">
                  <table className="trace-table">
                    <thead>
                      <tr>
                        <th>Time</th>
                        <th>Type</th>
                        <th>Message</th>
                        <th>Latency</th>
                        <th>Metadata</th>
                      </tr>
                    </thead>
                    <tbody>
                      {trace.events.map((event: any) => (
                        <tr key={event.id || event.created_at + event.event_type}>
                          <td className="time-cell">
                            {new Date(event.created_at).toLocaleTimeString([], { hour12: false, fractionalSecondDigits: 3 })}
                          </td>
                          <td>
                            <span className="type-badge">{event.event_type}</span>
                          </td>
                          <td className="message-cell">{event.message}</td>
                          <td className="latency-cell">{event.latency_ms ? `${event.latency_ms}ms` : "-"}</td>
                          <td className="meta-cell" title={JSON.stringify(event.metadata, null, 2)}>
                            {event.metadata ? JSON.stringify(event.metadata) : "{}"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </details>
            ))}
          </div>
        </div>
      </section>

      <style dangerouslySetInnerHTML={{__html: `
        .trace-list {
          margin-top: 2rem;
          display: flex;
          flex-direction: column;
          gap: 1rem;
        }
        .trace-details {
          border: 1px solid var(--line);
          border-radius: 8px;
          background: var(--paper-strong);
          overflow: hidden;
        }
        .trace-details.status-finished {
          border-left: 4px solid var(--accent);
        }
        .trace-details.status-processing {
          border-left: 4px solid var(--warn);
        }
        .trace-details.status-new {
          border-left: 4px solid var(--action);
        }
        @keyframes pulse {
          0% { opacity: 0.4; }
          50% { opacity: 1; }
          100% { opacity: 0.4; }
        }
        .trace-details[open] .trace-indicator {
          transform: rotate(90deg);
        }
        .trace-summary {
          padding: 1rem;
          cursor: pointer;
          list-style: none;
          user-select: none;
          background: var(--paper);
          transition: background 0.2s;
        }
        .trace-summary:hover {
          background: var(--paper-strong);
        }
        .trace-summary::-webkit-details-marker {
          display: none;
        }
        .trace-header {
          display: flex;
          align-items: center;
          gap: 1rem;
        }
        .trace-indicator {
          font-size: 0.8rem;
          color: var(--muted);
          transition: transform 0.2s;
        }
        .trace-id {
          font-family: monospace;
          font-size: 0.9rem;
          color: var(--ink);
          font-weight: 500;
        }
        .trace-meta {
          font-size: 0.8rem;
          color: var(--muted);
          margin-top: 0.25rem;
        }
        .trace-table-container {
          border-top: 1px solid var(--line);
          overflow-x: auto;
        }
        .trace-table {
          width: 100%;
          border-collapse: collapse;
          text-align: left;
          font-size: 0.85rem;
        }
        .trace-table th {
          background: var(--paper);
          padding: 0.75rem 1rem;
          color: var(--text-subtle);
          font-weight: 600;
          border-bottom: 1px solid var(--line);
        }
        .trace-table td {
          padding: 0.75rem 1rem;
          border-bottom: 1px solid var(--line);
          color: var(--ink);
        }
        .trace-table tr:last-child td {
          border-bottom: none;
        }
        .trace-table tr:hover td {
          background: var(--paper);
        }
        .time-cell {
          color: var(--muted) !important;
          white-space: nowrap;
        }
        .type-badge {
          background: var(--disabled-bg);
          color: var(--ink);
          padding: 0.25rem 0.5rem;
          border-radius: 4px;
          font-size: 0.75rem;
          font-weight: 600;
          white-space: nowrap;
        }
        .message-cell {
          font-weight: 500;
        }
        .latency-cell {
          color: var(--muted) !important;
          white-space: nowrap;
        }
        .meta-cell {
          font-family: monospace;
          color: var(--text-subtle) !important;
          max-width: 250px;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .meta-cell:hover {
          white-space: normal;
          word-break: break-all;
        }
      `}} />
    </main>
  );
}
