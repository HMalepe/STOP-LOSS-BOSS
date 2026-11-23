import { tradingRoutes } from "@/server/http/routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST(req: Request): Promise<Response> {
  return tradingRoutes.createPlan(req);
}
