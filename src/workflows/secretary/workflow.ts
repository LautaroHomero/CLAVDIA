import { getWritable } from "workflow";
import { DurableAgent } from "@workflow/ai/agent";
import { anthropic } from "@workflow/ai/anthropic";
import { convertToModelMessages, type UIMessage, type UIMessageChunk } from "ai";
import { loadAgentInstructions } from "@/lib/agent/instructions";
import type { Actor } from "@/lib/domain/types";
import { secretaryTools, TOOLS_BY_ROLE } from "./tools";

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
    instructions,
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
