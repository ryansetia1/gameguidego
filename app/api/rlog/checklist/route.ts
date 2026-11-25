import { rlogChecklist, rlogToggle } from "@/lib/rlog-bridge.js";
import { rlogJson, verifiedUser } from "@/lib/rlog-route";

export const runtime = "nodejs";

/** Checklist of the RLog game matching this room (`?igdb=` and/or `?game=&platform=`). */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  return rlogJson(await rlogChecklist({ user: await verifiedUser(request), env: process.env, params }));
}

/** Toggle one step: `{ item_id, checklist_item_id, done }`. */
export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  return rlogJson(await rlogToggle({ user: await verifiedUser(request), env: process.env, body }));
}
