import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Role } from "@/lib/domain/types";

/**
 * The agent's behaviour is defined by plain-text files:
 *   - src/lib/agent/instructions.md        (shared base)
 *   - src/lib/agent/roles/<role>.md        (médico / recepción / paciente)
 *
 * Read inside a `"use step"` function because Node built-ins (`fs`, `path`) are
 * not available in workflow code. `next.config.ts` traces the folder into the
 * deployment bundle.
 */
export async function loadAgentInstructions(role: Role): Promise<string> {
  "use step";
  const root = process.cwd();
  const base = readFileSync(join(root, "src/lib/agent/instructions.md"), "utf8");
  const roleDoc = readFileSync(join(root, `src/lib/agent/roles/${role}.md`), "utf8");
  return `${base}\n\n${roleDoc}`;
}
