/** Server-component guard: the signed-in session, or a redirect to /login. Pages that show account data use it. */
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SESSION_COOKIE } from "@/server/auth/cookies";
import { validateSession, type Session } from "@/server/auth/login";
import { getAuthDeps } from "@/server/context";

export async function requireSession(): Promise<Session> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const s = await validateSession(await getAuthDeps(), token);
  if (s === null) redirect("/login");
  return s;
}
