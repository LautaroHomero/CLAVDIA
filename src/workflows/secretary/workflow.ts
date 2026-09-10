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

const MODEL = process.env.AGENT_MODEL ?? "claude-haiku-4-5-20251001";

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
    instructions: instructions + DATE_CONTEXT + identity,
    tools: secretaryTools,
  });

  // A founding professional keeps admin rights, so they can also onboard staff.
  const activeTools =
    actor.role === "medico" && actor.activeOrg?.canAdmin
      ? [...TOOLS_BY_ROLE.medico, "registerProfessional" as const]
      : TOOLS_BY_ROLE[actor.role];

  await agent.stream({
    messages: await convertToModelMessages(messages),
    writable,
    activeTools,
    experimental_context: actor,
    onError: ({ error }) => {
      console.error("[secretaryWorkflow] agent stream error:", error);
    },
  });
}
