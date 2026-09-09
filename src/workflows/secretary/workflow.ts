import { getWritable } from "workflow";
import { DurableAgent } from "@workflow/ai/agent";
import { anthropic } from "@workflow/ai/anthropic";
import { convertToModelMessages, type UIMessage, type UIMessageChunk } from "ai";
import { loadAgentInstructions } from "@/lib/agent/instructions";
import {
  DEMO_TODAY,
  DEMO_TODAY_LABEL,
  DEMO_TOMORROW,
  DEMO_TOMORROW_LABEL,
} from "@/lib/domain/clock";
import type { Actor } from "@/lib/domain/types";
import { secretaryTools, TOOLS_BY_ROLE } from "./tools";

const DATE_CONTEXT = `

## Fecha de referencia (IMPORTANTE)

Hoy es **${DEMO_TODAY_LABEL}** (${DEMO_TODAY}). Mañana es ${DEMO_TOMORROW_LABEL} (${DEMO_TOMORROW}).
Resolvé "hoy", "mañana", "esta semana", "la semana que viene", etc. a partir de
esta fecha, y pasá siempre las fechas a las herramientas en formato AAAA-MM-DD.
No calcules el día de la semana por tu cuenta ni uses otra fecha como "actual".`;

const MODEL = process.env.AGENT_MODEL ?? "claude-sonnet-4-5";

/**
 * The durable medical-secretary agent.
 *
 * `actor` (derived from the session) selects the role instructions and the
 * allowed tool set, and is passed into every tool call via `experimental_context`
 * so tools can scope data (e.g. a patient only ever sees their own record).
 *
 * When a tool calls `requestHumanApproval` / `askHumanInput`, the workflow
 * suspends on a hook and consumes no resources until a human answers in the web
 * UI or in Slack — even across deploys.
 */
export async function secretaryWorkflow(messages: UIMessage[], actor: Actor) {
  "use workflow";

  const writable = getWritable<UIMessageChunk>();
  const instructions = await loadAgentInstructions(actor.role);

  const agent = new DurableAgent({
    model: anthropic(MODEL),
    instructions: instructions + DATE_CONTEXT,
    tools: secretaryTools,
  });

  await agent.stream({
    messages: await convertToModelMessages(messages),
    writable,
    activeTools: TOOLS_BY_ROLE[actor.role],
    experimental_context: actor,
    onError: ({ error }) => {
      console.error("[secretaryWorkflow] agent stream error:", error);
    },
  });
}
