import { settingsRoutes } from "@/server/http/routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(req: Request): Promise<Response> {
  return settingsRoutes.capsGet(req);
}

export function POST(req: Request): Promise<Response> {
  return settingsRoutes.capsSet(req);
}
