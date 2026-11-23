/** Playwright web server pre-step: a fresh embedded database with a known owner, so the e2e suite can sign in. */
import { rmSync } from "node:fs";
import { createOwner } from "@/server/auth/owner";
import { migrate } from "@/server/db/migrate";
import { pgliteDb } from "@/server/db/pglite";
import { E2E_DB_DIR, E2E_PASSWORD, E2E_SESSION_SECRET, E2E_TOTP_SECRET } from "../tests/e2e/fixtures";

async function main(): Promise<void> {
  rmSync(E2E_DB_DIR, { recursive: true, force: true });
  const db = pgliteDb(E2E_DB_DIR);
  await migrate(db);
  await createOwner(db, {
    password: E2E_PASSWORD,
    sessionSecret: E2E_SESSION_SECRET,
    totpSecret: E2E_TOTP_SECRET,
  });
  await db.close();
  process.stdout.write(`e2e owner seeded in ${E2E_DB_DIR}\n`);
}

void main();
