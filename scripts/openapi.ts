/** pnpm openapi: regenerate docs/openapi.json from the Zod contract. */
import { writeFileSync } from "node:fs";
import { buildOpenApi } from "@/server/http/contract";

writeFileSync("docs/openapi.json", `${JSON.stringify(buildOpenApi(), null, 2)}\n`);
process.stdout.write("docs/openapi.json written\n");
