import { getDb } from "@/lib/db/connection";
import type { HumanResponse, PendingHumanRequest } from "./types";

/**
 * The human-in-the-loop request queue, stored in SQLite so it is a single
 * source of truth shared by the workflow steps, the web UI and the Slack
 * webhook (an in-memory map would not survive the workflow's per-step
 * route isolation).
 */

type Row = Record<string, unknown>;

function toPending(r: Row): PendingHumanRequest {
  return {
    token: r.token as string,
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

export function addPendingRequest(req: PendingHumanRequest): void {
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO pending_requests
        (token, run_id, kind, action, summary, details, risk_level, patient_name,
         question, requested_by, created_at, channels, slack_channel, slack_ts, status)
       VALUES
        (@token, @run_id, @kind, @action, @summary, @details, @risk_level, @patient_name,
         @question, @requested_by, @created_at, @channels, @slack_channel, @slack_ts, 'open')`,
    )
    .run({
      token: req.token,
      run_id: req.runId,
      kind: req.kind,
      action: req.action,
      summary: req.summary,
      details: req.details ?? null,
      risk_level: req.riskLevel ?? null,
      patient_name: req.patientName ?? null,
      question: req.question ?? null,
      requested_by: req.requestedBy ?? null,
      created_at: req.createdAt,
      channels: JSON.stringify(req.channels),
      slack_channel: req.slack?.channel ?? null,
      slack_ts: req.slack?.ts ?? null,
    });
}

export function getPendingRequest(token: string): PendingHumanRequest | undefined {
  const r = getDb()
    .prepare("SELECT * FROM pending_requests WHERE token = ? AND status = 'open'")
    .get(token) as Row | undefined;
  return r ? toPending(r) : undefined;
}

export function listPendingRequests(): PendingHumanRequest[] {
  return (
    getDb()
      .prepare("SELECT * FROM pending_requests WHERE status = 'open' ORDER BY created_at")
      .all() as Row[]
  ).map(toPending);
}

/** Mark a request resolved (called after the hook is resumed). */
export function resolvePendingRequest(
  token: string,
  response: HumanResponse,
): void {
  getDb()
    .prepare(
      `UPDATE pending_requests
       SET status = 'resolved', resolved_by = ?, resolved_at = ?, response = ?
       WHERE token = ?`,
    )
    .run(response.respondedBy ?? null, new Date().toISOString(), JSON.stringify(response), token);
}

/** Back-compat alias used by the workflow's finalize step. */
export function removePendingRequest(token: string): void {
  getDb()
    .prepare(
      "UPDATE pending_requests SET status = 'resolved', resolved_at = ? WHERE token = ? AND status = 'open'",
    )
    .run(new Date().toISOString(), token);
}
