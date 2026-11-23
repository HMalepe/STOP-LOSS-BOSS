/** The route handlers wired to the real process services. Route files import from here. */
import { getAuthDeps } from "@/server/context";
import { makeAuthRoutes } from "./authRoutes";

export const authRoutes = makeAuthRoutes(getAuthDeps);
