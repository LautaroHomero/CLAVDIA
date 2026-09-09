import { getWritable } from "workflow";
import { DurableAgent } from "@workflow/ai/agent";
import { anthropic } from "@workflow/ai/anthropic";
import { convertToModelMessages, type UIMessage, type UIMessageChunk } from "ai";
import { loadAgentInstructions } from "@/lib/agent/instructions";
import { secretaryTools } from "./tools";

const MODEL = process.env.AGENT_MODEL ?? "claude-sonnet-4-5";

/**
 * The durable medical-secretary agent.
 *
 * Every run is resumable: when a tool calls `requestHumanApproval` /
 * `askHumanInput`, the workflow suspends on a hook and consumes no resources
 * until a human answers in the web UI or in Slack — even across deploys.
 */
export async function secretaryWorkflow(messages: UIMessage[]) {
  "use workflow";

  const writable = getWritable<UIMessageChunk>();
  const instructions = await loadAgentInstructions();

  const agent = new DurableAgent({
    model: anthropic(MODEL),
    instructions,
    tools: secretaryTools,
  });

  await agent.stream({
    messages: await convertToModelMessages(messages),
    writable,
    onError: ({ error }) => {
      console.error("[secretaryWorkflow] agent stream error:", error);
    },
  });
}
