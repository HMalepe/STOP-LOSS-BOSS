import { presetRoutes } from "@/server/http/routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(req: Request): Promise<Response> {
  return presetRoutes.list(req);
}

export function POST(req: Request): Promise<Response> {
  return presetRoutes.create(req);
}
