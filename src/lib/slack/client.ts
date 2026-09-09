import { createHmac, timingSafeEqual } from "node:crypto";
import type { PendingHumanRequest } from "@/lib/approvals/types";
import { buildRequestBlocks, buildResolvedBlocks } from "./blocks";

const SLACK_API = "https://slack.com/api";

export function isSlackEnabled(): boolean {
  return Boolean(process.env.SLACK_BOT_TOKEN && process.env.SLACK_APPROVAL_CHANNEL);
}

interface PostResult {
  ok: boolean;
  channel?: string;
  ts?: string;
  error?: string;
}

/** Posts an approval / input request to the configured Slack channel. */
export async function postHumanRequest(req: PendingHumanRequest): Promise<PostResult> {
  if (!isSlackEnabled()) return { ok: false, error: "slack-not-configured" };

  const res = await fetch(`${SLACK_API}/chat.postMessage`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
    },
    body: JSON.stringify({
      channel: process.env.SLACK_APPROVAL_CHANNEL,
      text:
        req.kind === "approval"
          ? `Aprobación solicitada: ${req.action}`
          : `Consulta del secretario: ${req.action}`,
      blocks: buildRequestBlocks(req),
    }),
  });
  const data = (await res.json()) as PostResult;
  return data;
}

/** Posts a plain-text message to the approvals channel (used by the day-close summary). */
export async function postText(text: string): Promise<boolean> {
  if (!isSlackEnabled()) return false;
  const res = await fetch(`${SLACK_API}/chat.postMessage`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
    },
    body: JSON.stringify({ channel: process.env.SLACK_APPROVAL_CHANNEL, text }),
  }).catch(() => null);
  if (!res) return false;
  const data = (await res.json().catch(() => ({}))) as { ok?: boolean };
  return Boolean(data.ok);
}

/** Rewrites the original Slack message once the request is resolved. */
export async function updateResolvedMessage(
  req: PendingHumanRequest,
  outcome: string,
): Promise<void> {
  if (!isSlackEnabled() || !req.slack) return;
  await fetch(`${SLACK_API}/chat.update`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
    },
    body: JSON.stringify({
      channel: req.slack.channel,
      ts: req.slack.ts,
      text: `Resuelto: ${req.action} — ${outcome}`,
      blocks: buildResolvedBlocks(req, outcome),
    }),
  }).catch(() => undefined);
}

/**
 * Verifies the `X-Slack-Signature` header per
 * https://api.slack.com/authentication/verifying-requests-from-slack
 */
export function verifySlackSignature(
  rawBody: string,
  timestamp: string | null,
  signature: string | null,
): boolean {
  const secret = process.env.SLACK_SIGNING_SECRET;
  if (!secret || !timestamp || !signature) return false;

  // Reject requests older than 5 minutes (replay protection).
  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(age) || age > 60 * 5) return false;

  const base = `v0:${timestamp}:${rawBody}`;
  const expected = `v0=${createHmac("sha256", secret).update(base).digest("hex")}`;
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}
