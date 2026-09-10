import { actorFromRequest } from "@/lib/auth/actor";
import {
  getMedication,
  getPatient,
  listMedications,
  patientInOrg,
  removeMedication,
  updateMedication,
} from "@/lib/db/repo";
import type { Actor } from "@/lib/domain/types";

async function guard(
  req: Request,
  ctx: { params: Promise<{ id: string; medId: string }> },
): Promise<{ ok: true; id: string; medId: string } | { ok: false; res: Response }> {
  const actor = actorFromRequest(req) as Actor | null;
  if (!actor || actor.role === "paciente") {
    return { ok: false, res: Response.json({ ok: false, error: "Solo personal del consultorio." }, { status: 403 }) };
  }
  const { id, medId } = await ctx.params;
  const orgId = actor.activeOrg?.id;
  if (!orgId || !getPatient(id) || !patientInOrg(id, orgId)) {
    return {
      ok: false,
      res: Response.json({ ok: false, error: "Ese paciente no está en este consultorio." }, { status: 403 }),
    };
  }
  const med = getMedication(medId);
  if (!med || med.patientId !== id) {
    return { ok: false, res: Response.json({ ok: false, error: "Medicación no encontrada." }, { status: 404 }) };
  }
  return { ok: true, id, medId };
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string; medId: string }> }) {
  const g = await guard(req, ctx);
  if (!g.ok) return g.res;
  const body = (await req.json()) as { name?: string; dose?: string; lastPrescribed?: string; chronic?: boolean };
  updateMedication(g.medId, body);
  return Response.json({ ok: true, medications: listMedications(g.id) });
}

export async function DELETE(req: Request, ctx: { params: Promise<{ id: string; medId: string }> }) {
  const g = await guard(req, ctx);
  if (!g.ok) return g.res;
  removeMedication(g.medId);
  return Response.json({ ok: true, medications: listMedications(g.id) });
}
