import { rlogPlaying } from "@/lib/rlog-bridge.js";
import { rlogJson, verifiedUser } from "@/lib/rlog-route";

export const runtime = "nodejs";

/** RLog games with status "playing" for the signed-in, verified user (#71). */
export async function GET(request: Request) {
  return rlogJson(await rlogPlaying({ user: await verifiedUser(request), env: process.env }));
}
