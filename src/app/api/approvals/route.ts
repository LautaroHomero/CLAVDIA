import { resumeHook } from "workflow/api";
import { getPendingRequest, listPendingRequests } from "@/lib/approvals/registry";
import type { HumanResponse } from "@/lib/approvals/types";
import { actorFromRequest } from "@/lib/auth/session";
import { isSlackEnabled } from "@/lib/slack/client";

/** Pending human-in-the-loop requests, scoped to the caller's role. */
export async function GET(req: Request) {
  const actor = actorFromRequest(req);
  if (!actor) return Response.json({ error: "No autenticado." }, { status: 401 });

  let pending = listPendingRequests();
  // Patients only see the requests their own chat generated.
  if (actor.role === "paciente") {
    pending = pending.filter((r) => r.requestedBy === actor.name);
  }

  return Response.json({
    slackEnabled: isSlackEnabled(),
    role: actor.role,
    pending,
  });
}

interface DecisionBody {
  token: string;
  approved?: boolean;
  answer?: string;
  note?: string;
}

/** Resume a suspended workflow with a human decision (used by the web UI). */
export async function POST(req: Request) {
  const actor = actorFromRequest(req);
  if (!actor) return Response.json({ error: "No autenticado." }, { status: 401 });

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
    respondedBy: `${actor.name} (${actor.role})`,
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
