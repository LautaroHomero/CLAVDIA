export type RiskLevel = "bajo" | "medio" | "alto";

export type HumanRequestKind = "approval" | "input";

/** What the workflow is waiting on. Surfaced in the UI and in Slack. */
export interface PendingHumanRequest {
  /** Hook token — equals the agent tool call id. */
  token: string;
  /** Workflow run this request belongs to. */
  runId: string;
  kind: HumanRequestKind;
  /** Short action label, e.g. "Renovación de receta". */
  action: string;
  /** Full context written by the agent for the human reviewer. */
  summary: string;
  /** Optional structured extra detail. */
  details?: string;
  riskLevel?: RiskLevel;
  patientName?: string;
  /** For input requests: the concrete question. */
  question?: string;
  /** Name of the person whose chat triggered this (e.g. "Recepción (Sofía)"). */
  requestedBy?: string;
  createdAt: string;
  /** Where the notification was delivered. */
  channels: ("slack" | "in-app")[];
  /** Reference to the posted Slack message, so it can be updated on resolution. */
  slack?: { channel: string; ts: string };
}

/** Payload sent back to resume the workflow. */
export interface HumanResponse {
  /** For approval requests. */
  approved?: boolean;
  /** For input requests. */
  answer?: string;
  /** Free-text note from the reviewer (reason for rejection, extra instruction). */
  note?: string;
  /** Display name / channel of whoever responded. */
  respondedBy?: string;
  /** Set when the workflow resolved the request itself (timeout). */
  timedOut?: boolean;
}
