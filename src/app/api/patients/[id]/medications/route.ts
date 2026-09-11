import { actorFromRequest } from "@/lib/auth/actor";
import { addMedication, getPatient, listMedications, patientInOrg } from "@/lib/db/repo";

/** Add a medication to a patient's ficha (staff, patient must be in the org). */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const actor = await actorFromRequest(req);
  if (!actor || actor.role === "paciente") {
    return Response.json({ ok: false, error: "Solo personal del consultorio." }, { status: 403 });
  }
  const { id } = await ctx.params;
  const orgId = actor.activeOrg?.id;
  if (!orgId || !(await getPatient(id)) || !(await patientInOrg(id, orgId))) {
    return Response.json({ ok: false, error: "Ese paciente no está en este consultorio." }, { status: 403 });
  }

  const body = (await req.json()) as { name?: string; dose?: string; lastPrescribed?: string; chronic?: boolean };
  if (!body.name?.trim() || !body.dose?.trim()) {
    return Response.json({ ok: false, error: "Indicá nombre y dosis." }, { status: 400 });
  }
  await addMedication({
    patientId: id,
    name: body.name,
    dose: body.dose,
    lastPrescribed: body.lastPrescribed,
    chronic: Boolean(body.chronic),
  });
  return Response.json({ ok: true, medications: await listMedications(id) });
}
