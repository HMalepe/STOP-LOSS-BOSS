import { adminRoutes } from "@/server/http/routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Sign out everywhere (re-auth required). */
export function POST(req: Request): Promise<Response> {
  return adminRoutes.revokeAllSessions(req);
}
