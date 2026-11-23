import { adminRoutes } from "@/server/http/routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(req: Request): Promise<Response> {
  return adminRoutes.killSwitchGet(req);
}

export function POST(req: Request): Promise<Response> {
  return adminRoutes.killSwitchSet(req);
}
