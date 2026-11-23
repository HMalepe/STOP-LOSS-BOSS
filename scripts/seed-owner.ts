/**
 * pnpm seed:owner [--replace]
 * Creates the single owner: asks for a password (not echoed), shows a TOTP QR code for your authenticator app, and prints
 * 10 recovery codes ONCE. Needs SESSION_SECRET; DATABASE_URL defaults to mock mode's embedded database.
 * --replace rotates the owner IN PLACE: new password, TOTP and recovery codes, and every session is signed out.
 * Run it with the app stopped when the database is embedded (pglite: one process at a time).
 */
import { createInterface } from "node:readline";
import QRCode from "qrcode";
import { createOwner } from "@/server/auth/owner";
import { migrate } from "@/server/db/migrate";
import { pgliteDir } from "@/server/context";
import { pgliteDb } from "@/server/db/pglite";
import { postgresDb } from "@/server/db/postgres";
import { MOCK_DATABASE_URL } from "@/server/env";

function ask(question: string, hidden: boolean): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      // Mute echo: print the question, then swallow what's typed.
      const out = rl as unknown as { _writeToOutput: (s: string) => void };
      out._writeToOutput = (s: string) => {
        if (s.includes(question)) process.stdout.write(s);
      };
    }
    rl.question(question, (answer) => {
      rl.close();
      if (hidden) process.stdout.write("\n");
      resolve(answer);
    });
  });
}

async function main(): Promise<void> {
  const given = process.env.DATABASE_URL?.trim();
  const url = given === undefined || given === "" ? MOCK_DATABASE_URL : given;
  const secret = process.env.SESSION_SECRET;
  if (secret === undefined || secret.length < 32) {
    process.stderr.write("Set SESSION_SECRET (32+ chars, the same one the app uses) first.\n");
    process.exit(1);
  }
  const db = url.startsWith("pglite:") ? pgliteDb(pgliteDir(url)) : postgresDb(url, { max: 1 });
  try {
    await migrate(db);
    const password = await ask("Owner password (12+ chars): ", true);
    const again = await ask("Same again: ", true);
    if (password !== again) throw new Error("Passwords don't match.");
    const owner = await createOwner(db, {
      password,
      sessionSecret: secret,
      replace: process.argv.includes("--replace"),
    });

    process.stdout.write(
      "\nScan this with your authenticator app (Google Authenticator, 1Password, Aegis…):\n\n",
    );
    process.stdout.write(await QRCode.toString(owner.otpauthUrl, { type: "terminal", small: true }));
    process.stdout.write(`\nOr enter this key by hand: ${owner.totpSecret}\n`);
    process.stdout.write(
      "\nRecovery codes. Each works ONCE. Store them offline now; they will never be shown again:\n\n",
    );
    for (const code of owner.recoveryCodes) process.stdout.write(`  ${code}\n`);
    process.stdout.write("\nDone.\n");
  } finally {
    await db.close();
  }
}

main().catch((e: unknown) => {
  process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
