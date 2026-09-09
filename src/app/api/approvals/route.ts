import { resumeHook } from "workflow/api";
import { getPendingRequest, listPendingRequests } from "@/lib/approvals/registry";
import type { HumanResponse } from "@/lib/approvals/types";
import { isSlackEnabled } from "@/lib/slack/client";

/** Pending human-in-the-loop requests, for the web UI panel. */
export async function GET() {
  return Response.json({
    slackEnabled: isSlackEnabled(),
    pending: listPendingRequests(),
  });
}

interface DecisionBody {
  token: string;
  approved?: boolean;
  answer?: string;
  note?: string;
  respondedBy?: string;
}

/** Resume a suspended workflow with a human decision (used by the web UI). */
export async function POST(req: Request) {
  const body = (await req.json()) as DecisionBody;
  if (!body?.token) {
    return Response.json({ ok: false, error: "Falta 'token'." }, { status: 400 });
  }

  const pending = getPendingRequest(body.token);
  if (!pending) {
    return Response.json(
      { ok: false, error: "Esa solicitud ya no está pendiente (resuelta o expirada)." },
      { status: 409 },
    );
  }

  const payload: HumanResponse = {
    approved: pending.kind === "approval" ? Boolean(body.approved) : undefined,
    answer: pending.kind === "input" ? (body.answer ?? "") : undefined,
    note: body.note,
    respondedBy: body.respondedBy?.trim() || "equipo (app)",
  };

  try {
    await resumeHook(body.token, payload);
    return Response.json({ ok: true });
  } catch (err) {
    return Response.json(
      { ok: false, error: (err as Error).message ?? "No se pudo reanudar el flujo." },
      { status: 500 },
    );
  }
}
