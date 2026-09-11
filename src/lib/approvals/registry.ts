import { getSql } from "@/lib/db/connection";
import type { HumanResponse, PendingHumanRequest } from "./types";

/**
 * The human-in-the-loop request queue, stored in Postgres so it is a single
 * source of truth shared by the workflow steps, the web UI and the Slack
 * webhook (an in-memory map would not survive the workflow's per-step
 * route isolation).
 */

type Row = Record<string, unknown>;

function toPending(r: Row): PendingHumanRequest {
  return {
    token: r.token as string,
    organizationId: r.organization_id as string,
    runId: r.run_id as string,
    kind: r.kind as PendingHumanRequest["kind"],
    action: r.action as string,
    summary: r.summary as string,
    details: (r.details as string) ?? undefined,
    riskLevel: (r.risk_level as PendingHumanRequest["riskLevel"]) ?? undefined,
    patientName: (r.patient_name as string) ?? undefined,
    question: (r.question as string) ?? undefined,
    requestedBy: (r.requested_by as string) ?? undefined,
    createdAt: r.created_at as string,
    channels: JSON.parse((r.channels as string) || "[]"),
    slack:
      r.slack_channel && r.slack_ts
        ? { channel: r.slack_channel as string, ts: r.slack_ts as string }
        : undefined,
  };
}

export async function addPendingRequest(req: PendingHumanRequest): Promise<void> {
  await getSql()`
    INSERT INTO pending_requests
      (token, organization_id, run_id, kind, action, summary, details, risk_level, patient_name,
       question, requested_by, created_at, channels, slack_channel, slack_ts, status)
    VALUES
      (${req.token}, ${req.organizationId}, ${req.runId}, ${req.kind}, ${req.action}, ${req.summary},
       ${req.details ?? null}, ${req.riskLevel ?? null}, ${req.patientName ?? null}, ${req.question ?? null},
       ${req.requestedBy ?? null}, ${req.createdAt}, ${JSON.stringify(req.channels)},
       ${req.slack?.channel ?? null}, ${req.slack?.ts ?? null}, 'open')
    ON CONFLICT (token) DO UPDATE SET
      organization_id = EXCLUDED.organization_id, run_id = EXCLUDED.run_id, kind = EXCLUDED.kind,
      action = EXCLUDED.action, summary = EXCLUDED.summary, details = EXCLUDED.details,
      risk_level = EXCLUDED.risk_level, patient_name = EXCLUDED.patient_name, question = EXCLUDED.question,
      requested_by = EXCLUDED.requested_by, created_at = EXCLUDED.created_at, channels = EXCLUDED.channels,
      slack_channel = EXCLUDED.slack_channel, slack_ts = EXCLUDED.slack_ts, status = 'open'`;
}

export async function getPendingRequest(token: string): Promise<PendingHumanRequest | undefined> {
  const [r] = (await getSql()`
    SELECT * FROM pending_requests WHERE token = ${token} AND status = 'open'`) as unknown as Row[];
  return r ? toPending(r) : undefined;
}

export async function listPendingRequests(orgId?: string): Promise<PendingHumanRequest[]> {
  const sql = getSql();
  const rows = orgId
    ? ((await sql`SELECT * FROM pending_requests WHERE status = 'open' AND organization_id = ${orgId} ORDER BY created_at`) as unknown as Row[])
    : ((await sql`SELECT * FROM pending_requests WHERE status = 'open' ORDER BY created_at`) as unknown as Row[]);
  return rows.map(toPending);
}

/** Mark a request resolved (called after the hook is resumed). */
export async function resolvePendingRequest(token: string, response: HumanResponse): Promise<void> {
  await getSql()`
    UPDATE pending_requests
    SET status = 'resolved', resolved_by = ${response.respondedBy ?? null},
        resolved_at = ${new Date().toISOString()}, response = ${JSON.stringify(response)}
    WHERE token = ${token}`;
}

/** Back-compat alias used by the workflow's finalize step. */
export async function removePendingRequest(token: string): Promise<void> {
  await getSql()`
    UPDATE pending_requests SET status = 'resolved', resolved_at = ${new Date().toISOString()}
    WHERE token = ${token} AND status = 'open'`;
}
