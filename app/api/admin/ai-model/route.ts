import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

import { isAdminEmail } from "@/lib/admin-constants";
import { AI_MODELS, isAllowedModel } from "@/lib/ai-models.js";
import {
  AI_MODEL_SETTING_KEY,
  clearActiveModelCache,
  getActiveModel,
  readStoredModel,
} from "@/lib/active-model";
import { getServiceClient } from "@/lib/supabase-server.js";

export const runtime = "nodejs";

const OPTIONS = Object.entries(AI_MODELS).map(([id, { label }]) => ({ id, label }));

/** 401/403 response, or null when the bearer token belongs to the admin. */
async function denyUnlessAdmin(request: Request): Promise<NextResponse | null> {
  const authHeader = request.headers.get("authorization");
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    return NextResponse.json({ error: "Server not configured" }, { status: 501 });
  }
  const authClient = createClient(url, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data, error } = await authClient.auth.getUser(token);
  if (error || !isAdminEmail(data.user?.email)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  return null;
}

export async function GET(request: Request) {
  const denied = await denyUnlessAdmin(request);
  if (denied) return denied;
  clearActiveModelCache();
  const [active, stored] = await Promise.all([getActiveModel(), readStoredModel()]);
  return NextResponse.json({ active, stored, options: OPTIONS });
}

export async function POST(request: Request) {
  const denied = await denyUnlessAdmin(request);
  if (denied) return denied;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }
  const model = (body as { model?: unknown } | null)?.model;
  if (!isAllowedModel(model)) {
    return NextResponse.json({ error: "Unknown model" }, { status: 400 });
  }

  const supabase = getServiceClient();
  if (!supabase) {
    return NextResponse.json({ error: "Server not configured" }, { status: 503 });
  }
  const { error } = await supabase
    .from("app_settings")
    .upsert({ key: AI_MODEL_SETTING_KEY, value: model, updated_at: new Date().toISOString() });
  if (error) {
    console.error("AI model save failed:", error);
    return NextResponse.json({ error: "Couldn't save the model." }, { status: 500 });
  }
  clearActiveModelCache();
  return NextResponse.json({ active: await getActiveModel(), stored: model, options: OPTIONS });
}
