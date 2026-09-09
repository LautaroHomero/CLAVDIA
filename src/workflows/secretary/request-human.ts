import { getWorkflowMetadata } from "workflow";
import type {
  HumanRequestKind,
  HumanResponse,
  PendingHumanRequest,
  RiskLevel,
} from "@/lib/approvals/types";
import { addPendingRequest, resolvePendingRequest } from "@/lib/approvals/registry";
import { isSlackEnabled, postHumanRequest, updateResolvedMessage } from "@/lib/slack/client";
import { humanHook } from "./hooks";

export interface RequestHumanArgs {
  token: string;
  organizationId: string;
  kind: HumanRequestKind;
  action: string;
  summary: string;
  details?: string;
  riskLevel?: RiskLevel;
  patientName?: string;
  question?: string;
  /** Name of the person whose chat triggered this. */
  requestedBy?: string;
}

/**
 * Suspends the workflow until a human responds via the web UI or Slack.
 * Runs in workflow context (not a step) because it awaits a hook.
 *
 * The wait is durable and unbounded — the run consumes no resources while
 * suspended, and survives restarts/deploys. (A bounded wait could be layered on
 * with an external `Run.wakeUp()` on a schedule.)
 */
export async function requestHuman(args: RequestHumanArgs): Promise<HumanResponse> {
  const pending = await notifyHuman(args);
  const response = await humanHook.create({ token: args.token });
  await finalizeHuman(pending, response);
  return response;
}

// --- steps -----------------------------------------------------------------

async function notifyHuman(args: RequestHumanArgs): Promise<PendingHumanRequest> {
  "use step";

  const { workflowRunId } = getWorkflowMetadata();
  const req: PendingHumanRequest = {
    token: args.token,
    organizationId: args.organizationId,
    runId: workflowRunId,
    kind: args.kind,
    action: args.action,
    summary: args.summary,
    details: args.details,
    riskLevel: args.riskLevel,
    patientName: args.patientName,
    question: args.question,
    requestedBy: args.requestedBy,
    createdAt: new Date().toISOString(),
    channels: ["in-app"],
  };

  if (isSlackEnabled()) {
    const posted = await postHumanRequest(req);
    if (posted.ok && posted.ts && posted.channel) {
      req.channels = ["slack", "in-app"];
      req.slack = { channel: posted.channel, ts: posted.ts };
    }
  }

  addPendingRequest(req);
  return req;
}

async function finalizeHuman(
  req: PendingHumanRequest,
  response: HumanResponse,
): Promise<void> {
  "use step";

  const outcome =
    req.kind === "approval"
      ? response.approved
        ? `✅ Aprobado por ${response.respondedBy ?? "el equipo"}`
        : `⛔ Rechazado por ${response.respondedBy ?? "el equipo"}${
            response.note ? ` — ${response.note}` : ""
          }`
      : `✍️ Respondido por ${response.respondedBy ?? "el equipo"}: ${
          response.answer || "(sin texto)"
        }`;

  await updateResolvedMessage(req, outcome);
  resolvePendingRequest(req.token, response);
}
