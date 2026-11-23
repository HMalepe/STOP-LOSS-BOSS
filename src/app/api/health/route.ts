import { healthRoutes } from "@/server/http/routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(): Response {
  return healthRoutes.live();
}
