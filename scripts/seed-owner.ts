/**
 * pnpm seed:owner [--replace]
 * Creates the single owner: asks for a password (not echoed), shows a TOTP QR code for your authenticator app, and prints
 * 10 recovery codes ONCE. Needs DATABASE_URL and SESSION_SECRET in the environment.
 */
import { createInterface } from "node:readline";
import QRCode from "qrcode";
import { createOwner } from "@/server/auth/owner";
import { migrate } from "@/server/db/migrate";
import { postgresDb } from "@/server/db/postgres";

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
  const url = process.env.DATABASE_URL;
  const secret = process.env.SESSION_SECRET;
  if (url === undefined || url === "" || secret === undefined || secret.length < 32) {
    process.stderr.write("Set DATABASE_URL and SESSION_SECRET (32+ chars) first.\n");
    process.exit(1);
  }
  const db = postgresDb(url, { max: 1 });
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
