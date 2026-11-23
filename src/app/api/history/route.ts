import { tradingRoutes } from "@/server/http/routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(req: Request): Promise<Response> {
  return tradingRoutes.history(req);
}
