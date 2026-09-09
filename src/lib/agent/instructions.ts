import { readFileSync } from "node:fs";
import { join } from "node:path";

const INSTRUCTIONS_PATH = "src/lib/agent/instructions.md";

/**
 * The agent's behaviour is defined entirely by the plain-text file
 * `instructions.md` in this folder, so it can be edited without touching code.
 *
 * It is read inside a `"use step"` function: Node built-ins (`fs`, `path`) are
 * not available in workflow code itself, only inside steps. `next.config.ts`
 * traces the file into the deployment bundle via `outputFileTracingIncludes`.
 */
export async function loadAgentInstructions(): Promise<string> {
  "use step";
  return readFileSync(join(process.cwd(), INSTRUCTIONS_PATH), "utf8");
}
