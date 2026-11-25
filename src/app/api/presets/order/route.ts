import { presetRoutes } from "@/server/http/routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function PUT(req: Request): Promise<Response> {
  return presetRoutes.reorder(req);
}
