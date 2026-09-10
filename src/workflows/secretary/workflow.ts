import { getWritable } from "workflow";
import { DurableAgent } from "@workflow/ai/agent";
import { anthropic } from "@workflow/ai/anthropic";
import {
  convertToModelMessages,
  type ModelMessage,
  type UIMessage,
  type UIMessageChunk,
} from "ai";
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

const MODEL = process.env.AGENT_MODEL ?? "claude-haiku-4-5-20251001";

/**
 * Cost controls for the agent loop.
 *
 * `MAX_STEPS` bounds the tool-calling loop: without it a misbehaving tool that
 * keeps erroring can chain LLM calls indefinitely. `MAX_OUTPUT_TOKENS` is a
 * backstop, not a tuning knob — chat replies here are a paragraph at most.
 */
const MAX_STEPS = 10;
const MAX_OUTPUT_TOKENS = 2048;

/**
 * Prompt caching. The system prompt (base + role doc + date + identity) is
 * byte-stable for the whole conversation, and the tool schemas never change, so
 * they form a perfect cache prefix. `ttl: "1h"` (vs the 5-minute default)
 * because the workflow can suspend on a human-approval hook for a long time
 * between steps; the 2x write cost is repaid by the first miss it prevents.
 *
 * The conversation tail gets a separate 5-minute breakpoint so the multiple
 * LLM calls within a single turn (one per tool round-trip) re-read the history
 * from cache instead of re-billing it in full each step.
 */
const CACHE_PREFIX = {
  anthropic: { cacheControl: { type: "ephemeral", ttl: "1h" } },
} as const;
const CACHE_TAIL = {
  anthropic: { cacheControl: { type: "ephemeral" } },
} as const;

/** Mark the last message so everything up to it is served from cache on later steps. */
function withCachedTail(messages: ModelMessage[]): ModelMessage[] {
  const tail = messages.at(-1);
  if (tail) {
    tail.providerOptions = { ...tail.providerOptions, ...CACHE_TAIL };
  }
  return messages;
}

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

  let identity = "";
  if (actor.role === "paciente") {
    identity = actor.orgs.length
      ? `\n\n## Quién sos\nHablás con **${actor.name}** (paciente). Se atiende en: ${actor.orgs
          .map((o) => o.name)
          .join(", ")}. Si tiene turnos o pedidos en varios consultorios, tenelos todos en cuenta; cuando una acción necesite uno puntual y no quede claro, preguntá cuál.`
      : `\n\n## Quién sos\nHablás con **${actor.name}** (paciente). Todavía no eligió consultorio: para pedir un turno primero tiene que sumarse a uno (listOrganizations / joinOrganization).`;
  } else if (actor.activeOrg) {
    identity = `\n\n## Quién sos\nHablás con **${actor.name}**${
      actor.activeOrg.specialty ? `, ${actor.activeOrg.specialty}` : ` (${actor.role})`
    }, en **${actor.activeOrg.name}**. Todo lo que hacés es en ese consultorio; "mi agenda" / "mis pacientes" son de esta persona en esa organización.`;
  }

  const agent = new DurableAgent({
    model: anthropic(MODEL),
    // A `SystemModelMessage` (not a bare string) so the whole prompt + the tool
    // schemas render as one cached prefix — re-read at 0.1x on every later step.
    instructions: {
      role: "system",
      content: instructions + DATE_CONTEXT + identity,
      providerOptions: CACHE_PREFIX,
    },
    tools: secretaryTools,
  });

  // A founding professional keeps admin rights, so they can also onboard staff.
  const activeTools =
    actor.role === "medico" && actor.activeOrg?.canAdmin
      ? [...TOOLS_BY_ROLE.medico, "registerProfessional" as const]
      : TOOLS_BY_ROLE[actor.role];

  const orgId = actor.activeOrg?.id ?? actor.orgs[0]?.id ?? "-";

  await agent.stream({
    messages: withCachedTail(await convertToModelMessages(messages)),
    writable,
    activeTools,
    maxSteps: MAX_STEPS,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    experimental_context: actor,
    // Per-step token accounting — verifies caching is working and feeds
    // per-organization usage metering. Counts only; no message content is logged.
    onStepFinish: ({ usage, providerMetadata }) => {
      const a = providerMetadata?.anthropic as
        | { cacheCreationInputTokens?: number; cacheReadInputTokens?: number }
        | undefined;
      console.info("[secretary] llm-step", {
        org: orgId,
        role: actor.role,
        model: MODEL,
        input: usage.inputTokens ?? 0,
        output: usage.outputTokens ?? 0,
        cacheRead: a?.cacheReadInputTokens ?? usage.cachedInputTokens ?? 0,
        cacheWrite: a?.cacheCreationInputTokens ?? 0,
      });
    },
    onError: ({ error }) => {
      console.error("[secretaryWorkflow] agent stream error:", error);
    },
  });
}
