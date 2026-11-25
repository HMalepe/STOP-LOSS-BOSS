import { presetRoutes } from "@/server/http/routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Ctx {
  params: Promise<{ id: string }>;
}

export async function PUT(req: Request, ctx: Ctx): Promise<Response> {
  return presetRoutes.update(req, (await ctx.params).id);
}

export async function DELETE(req: Request, ctx: Ctx): Promise<Response> {
  return presetRoutes.remove(req, (await ctx.params).id);
}
