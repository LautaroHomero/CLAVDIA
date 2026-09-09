import { consumeStream, createUIMessageStreamResponse, type UIMessage } from "ai";
import { start } from "workflow/api";
import { secretaryWorkflow } from "@/workflows/secretary/workflow";

// The agent can pause for a human for a long time; keep the function alive.
export const maxDuration = 800;

export async function POST(req: Request) {
  const { messages }: { messages: UIMessage[] } = await req.json();

  // Start a durable run. It keeps executing (and streaming) even if this
  // request's connection drops.
  const run = await start(secretaryWorkflow, [messages]);

  return createUIMessageStreamResponse({
    stream: run.readable,
    headers: { "x-workflow-run-id": run.runId },
    // Drain the run's stream even if the browser disconnects mid-turn.
    consumeSseStream: async ({ stream }) => {
      try {
        await consumeStream({ stream });
      } catch {
        // client aborted — the durable run continues regardless
      }
    },
  });
}
