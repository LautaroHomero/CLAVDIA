import { resumeHook } from "workflow/api";
import { getPendingRequest } from "@/lib/approvals/registry";
import type { HumanResponse } from "@/lib/approvals/types";
import type { SlackActionValue } from "@/lib/slack/blocks";
import { verifySlackSignature } from "@/lib/slack/client";

/**
 * Slack Interactivity endpoint. Configure this URL in your Slack app under
 * "Interactivity & Shortcuts":  https://<host>/api/slack/actions
 */
export async function POST(req: Request) {
  const raw = await req.text();
  const ok = verifySlackSignature(
    raw,
    req.headers.get("x-slack-request-timestamp"),
    req.headers.get("x-slack-signature"),
  );
  if (!ok) return new Response("invalid signature", { status: 401 });

  const payloadRaw = new URLSearchParams(raw).get("payload");
  if (!payloadRaw) return new Response("", { status: 200 });

  const payload = JSON.parse(payloadRaw) as {
    type: string;
    user?: { username?: string; name?: string };
    actions?: { value?: string }[];
  };

  if (payload.type !== "block_actions" || !payload.actions?.length) {
    return new Response("", { status: 200 });
  }

  let action: SlackActionValue;
  try {
    action = JSON.parse(payload.actions[0]?.value ?? "") as SlackActionValue;
  } catch {
    return new Response("", { status: 200 });
  }

  const respondedBy = payload.user?.username || payload.user?.name || "Slack";
  const pending = await getPendingRequest(action.token);

  // Already resolved (or resolved by the web UI first) — acknowledge silently.
  if (!pending) return new Response("", { status: 200 });

  const response: HumanResponse = {
    approved: action.decision === "approve",
    respondedBy: `${respondedBy} (Slack)`,
  };

  try {
    await resumeHook(action.token, response);
  } catch {
    // race with another resolver — safe to ignore
  }

  return new Response("", { status: 200 });
}
