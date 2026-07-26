import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

import { ADMIN_EMAIL, isAdminEmail } from "@/lib/admin-constants";

export const runtime = "nodejs";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function labelFromUser(user: { email?: string; user_metadata?: Record<string, unknown> }): string {
  const meta = user.user_metadata ?? {};
  const display =
    (typeof meta.display_name === "string" && meta.display_name.trim()) ||
    (typeof meta.full_name === "string" && meta.full_name.trim()) ||
    (typeof meta.name === "string" && meta.name.trim()) ||
    "";
  if (display) return display.slice(0, 32);
  const email = user.email?.trim();
  if (email) return email.split("@")[0] ?? email;
  return "Signed-in user";
}

export async function POST(request: Request) {
  const authHeader = request.headers.get("authorization");
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (!token) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !anonKey || !serviceKey) {
    return NextResponse.json({ error: "Server not configured" }, { status: 501 });
  }

  const authClient = createClient(url, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: userData, error: userError } = await authClient.auth.getUser(token);
  if (userError || !isAdminEmail(userData.user?.email)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const rawIds = Array.isArray(record.userIds) ? record.userIds : [];
  const userIds = [...new Set(rawIds.filter((id): id is string => typeof id === "string" && UUID_RE.test(id)))].slice(
    0,
    50,
  );
  if (!userIds.length) {
    return NextResponse.json({ labels: {} });
  }

  const admin = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const labels: Record<string, string> = {};
  const emails: Record<string, string> = {};
  await Promise.all(
    userIds.map(async (userId) => {
      const { data, error } = await admin.auth.admin.getUserById(userId);
      if (!error && data.user) {
        labels[userId] = labelFromUser(data.user);
        const email = data.user.email?.trim().toLowerCase();
        if (email) emails[userId] = email;
      }
    }),
  );

  return NextResponse.json({ labels, emails });
}
