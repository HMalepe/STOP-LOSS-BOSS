import { presetRoutes } from "@/server/http/routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PUT(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  return presetRoutes.update(req, (await ctx.params).id);
}

export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  return presetRoutes.remove(req, (await ctx.params).id);
}
