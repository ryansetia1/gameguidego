import { rlogStatus } from "@/lib/rlog-bridge.js";
import { rlogJson, verifiedUser } from "@/lib/rlog-route";

export const runtime = "nodejs";

/** Playing/completed/dropped RLog games for the signed-in, verified user (#73). */
export async function GET(request: Request) {
  return rlogJson(await rlogStatus({ user: await verifiedUser(request), env: process.env }));
}
