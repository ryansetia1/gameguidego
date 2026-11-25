import { NextResponse } from "next/server";

import { getServerClient } from "@/lib/supabase-server.js";

/**
 * The Supabase user behind the request's Bearer token, verified by Supabase Auth
 * (never a client-claimed identity). Null when absent, invalid, or auth is unset.
 */
export async function verifiedUser(request: Request) {
  const token = (request.headers.get("authorization") ?? "").match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  const supabase = getServerClient();
  if (!token || !supabase) return null;
  try {
    const { data, error } = await supabase.auth.getUser(token);
    return error ? null : data.user;
  } catch {
    return null;
  }
}

export function rlogJson(result: { status: number; body: Record<string, unknown> }) {
  return NextResponse.json(result.body, {
    status: result.status,
    headers: { "Cache-Control": "private, no-store" },
  });
}
