import type { PendingHumanRequest, RiskLevel } from "@/lib/approvals/types";

const RISK_EMOJI: Record<RiskLevel, string> = {
  bajo: "🟢",
  medio: "🟡",
  alto: "🔴",
};

interface SlackBlock {
  type: string;
  [key: string]: unknown;
}

/** Value carried by the interactive buttons — parsed back in the webhook. */
export interface SlackActionValue {
  token: string;
  kind: PendingHumanRequest["kind"];
  decision: "approve" | "reject";
}

export function buildRequestBlocks(req: PendingHumanRequest): SlackBlock[] {
  const risk = req.riskLevel ? `${RISK_EMOJI[req.riskLevel]} Riesgo ${req.riskLevel}` : "";
  const header =
    req.kind === "approval"
      ? `Aprobación solicitada — ${req.action}`
      : `Consulta del secretario — ${req.action}`;

  const blocks: SlackBlock[] = [
    { type: "header", text: { type: "plain_text", text: header, emoji: true } },
  ];

  const contextParts = [req.patientName ? `👤 ${req.patientName}` : null, risk || null].filter(
    Boolean,
  ) as string[];
  if (contextParts.length) {
    blocks.push({
      type: "context",
      elements: contextParts.map((t) => ({ type: "mrkdwn", text: t })),
    });
  }

  blocks.push({
    type: "section",
    text: { type: "mrkdwn", text: truncate(req.summary, 2900) },
  });

  if (req.details) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: truncate(req.details, 2900) },
    });
  }

  if (req.kind === "approval") {
    blocks.push({
      type: "actions",
      block_id: `human_${req.token}`,
      elements: [
        {
          type: "button",
          style: "primary",
          text: { type: "plain_text", text: "Aprobar", emoji: true },
          action_id: "human_approve",
          value: JSON.stringify({
            token: req.token,
            kind: req.kind,
            decision: "approve",
          } satisfies SlackActionValue),
        },
        {
          type: "button",
          style: "danger",
          text: { type: "plain_text", text: "Rechazar", emoji: true },
          action_id: "human_reject",
          value: JSON.stringify({
            token: req.token,
            kind: req.kind,
            decision: "reject",
          } satisfies SlackActionValue),
        },
      ],
    });
  } else {
    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: "✍️ Respondé esta consulta desde la app del secretario médico.",
        },
      ],
    });
  }

  return blocks;
}

export function buildResolvedBlocks(
  req: PendingHumanRequest,
  outcome: string,
): SlackBlock[] {
  return [
    {
      type: "header",
      text: { type: "plain_text", text: `Resuelto — ${req.action}`, emoji: true },
    },
    req.patientName
      ? { type: "context", elements: [{ type: "mrkdwn", text: `👤 ${req.patientName}` }] }
      : { type: "divider" },
    { type: "section", text: { type: "mrkdwn", text: truncate(req.summary, 2900) } },
    { type: "context", elements: [{ type: "mrkdwn", text: outcome }] },
  ];
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
