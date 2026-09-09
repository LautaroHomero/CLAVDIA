import { getWorkflowMetadata, sleep } from "workflow";
import type {
  HumanRequestKind,
  HumanResponse,
  PendingHumanRequest,
  RiskLevel,
} from "@/lib/approvals/types";
import { addPendingRequest, removePendingRequest } from "@/lib/approvals/registry";
import { isSlackEnabled, postHumanRequest, updateResolvedMessage } from "@/lib/slack/client";
import { humanHook } from "./hooks";

/** How long the workflow waits for a human before falling back. */
const HUMAN_TIMEOUT = "24h";

export interface RequestHumanArgs {
  token: string;
  kind: HumanRequestKind;
  action: string;
  summary: string;
  details?: string;
  riskLevel?: RiskLevel;
  patientName?: string;
  question?: string;
}

/**
 * Suspends the workflow until a human responds via the web UI or Slack.
 * Runs in workflow context (not a step) because it awaits a hook.
 */
export async function requestHuman(args: RequestHumanArgs): Promise<HumanResponse> {
  const pending = await notifyHuman(args);

  const timeout = sleep(HUMAN_TIMEOUT).then<HumanResponse>(() => ({
    approved: args.kind === "approval" ? false : undefined,
    answer: args.kind === "input" ? "" : undefined,
    timedOut: true,
    note: `Sin respuesta humana dentro de ${HUMAN_TIMEOUT}.`,
    respondedBy: "sistema (timeout)",
  }));

  const response = await Promise.race([humanHook.create({ token: args.token }), timeout]);

  await finalizeHuman(pending, response);
  return response;
}

// --- steps -----------------------------------------------------------------

async function notifyHuman(args: RequestHumanArgs): Promise<PendingHumanRequest> {
  "use step";

  const { workflowRunId } = getWorkflowMetadata();
  const req: PendingHumanRequest = {
    token: args.token,
    runId: workflowRunId,
    kind: args.kind,
    action: args.action,
    summary: args.summary,
    details: args.details,
    riskLevel: args.riskLevel,
    patientName: args.patientName,
    question: args.question,
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
  removePendingRequest(req.token);
}
