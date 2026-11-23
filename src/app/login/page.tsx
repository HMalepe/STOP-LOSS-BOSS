import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { SESSION_COOKIE } from "@/server/auth/cookies";
import { validateSession } from "@/server/auth/login";
import { getAuthDeps } from "@/server/context";
import { getEnv } from "@/server/env";
import { LoginFlow } from "./LoginFlow";

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if ((await validateSession(await getAuthDeps(), token)) !== null) redirect("/");
  return <LoginFlow mode={getEnv().TRADING_MODE} />;
}
