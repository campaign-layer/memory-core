import path from "node:path";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { hermesToolSchemas } from "./adapters/hermes.js";

// Regenerates the Hermes Python plugin's schemas.json from tools.ts so zod stays
// the single source of truth. Run: npx tsx src/integrations/generate-schemas.ts

const here = path.dirname(fileURLToPath(import.meta.url));
const target = path.join(here, "adapters", "hermes-plugin", "schemas.json");

await writeFile(target, `${JSON.stringify(hermesToolSchemas(), null, 2)}\n`, "utf8");
process.stderr.write(`[memory-core] wrote ${target}\n`);
