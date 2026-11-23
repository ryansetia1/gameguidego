"use client";

import { useEffect, useState } from "react";

import { getSupabase } from "@/lib/supabase";

type ModelState = {
  active: string;
  stored: string | null;
  options: Array<{ id: string; label: string }>;
};

async function adminFetch(init?: RequestInit): Promise<ModelState> {
  const supabase = getSupabase();
  const { data } = (await supabase?.auth.getSession()) ?? { data: { session: null } };
  const token = data.session?.access_token;
  if (!token) throw new Error("Session expired");
  const response = await fetch("/api/admin/ai-model", {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || "Couldn't load the model.");
  return payload as ModelState;
}

/** Admin-only: which AI model answers for everyone. */
export function ModelPicker() {
  const [state, setState] = useState<ModelState | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    adminFetch()
      .then(setState)
      .catch((err: Error) => setError(err.message));
  }, []);

  const choose = async (model: string) => {
    setSaving(true);
    setError(null);
    try {
      setState(await adminFetch({ method: "POST", body: JSON.stringify({ model }) }));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const known = state?.options.some((option) => option.id === state.active);

  return (
    <div className="activity-toolbar">
      <label className="profile-hint" htmlFor="admin-ai-model">
        AI model
      </label>
      <select
        id="admin-ai-model"
        className="activity-filter"
        value={state?.active ?? ""}
        disabled={!state || saving}
        onChange={(event) => void choose(event.target.value)}
      >
        {!state && <option value="">Loading...</option>}
        {state && !known && <option value={state.active}>{state.active}</option>}
        {state?.options.map((option) => (
          <option key={option.id} value={option.id}>
            {option.label}
          </option>
        ))}
      </select>
      <span className="profile-hint" role="status">
        {error ?? (saving ? "Saving..." : state && !state.stored ? "Using the default" : "")}
      </span>
    </div>
  );
}
