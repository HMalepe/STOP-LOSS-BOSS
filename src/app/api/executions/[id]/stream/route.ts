import { tradingRoutes } from "@/server/http/routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  return tradingRoutes.stream(req, (await ctx.params).id);
}
