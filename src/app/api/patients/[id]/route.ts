import { actorFromRequest } from "@/lib/auth/actor";
import {
  getPatient,
  getPatientByDni,
  listMedications,
  patientInOrg,
  updatePatient,
  type PatientPatch,
} from "@/lib/db/repo";
import type { Actor } from "@/lib/domain/types";

type Access = { ok: true } | { ok: false; status: number; error: string };

async function checkAccess(actor: Actor, patientId: string): Promise<Access> {
  if (actor.role === "paciente") {
    return actor.patientId === patientId
      ? { ok: true }
      : { ok: false, status: 403, error: "Solo podés ver tu propia ficha." };
  }
  const orgId = actor.activeOrg?.id;
  if (!orgId) return { ok: false, status: 400, error: "Sin organización activa." };
  return (await patientInOrg(patientId, orgId))
    ? { ok: true }
    : { ok: false, status: 403, error: "Ese paciente no está en este consultorio." };
}

async function ficha(patientId: string) {
  const [p, medications] = await Promise.all([getPatient(patientId), listMedications(patientId)]);
  const patient = p!;
  return {
    id: patient.id,
    fullName: patient.fullName,
    dni: patient.dni,
    dateOfBirth: patient.dateOfBirth,
    phone: patient.phone,
    email: patient.email,
    coverage: patient.coverage,
    allergies: patient.allergies,
    activeConditions: patient.activeConditions,
    notes: patient.notes ?? "",
    medications,
  };
}

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const actor = await actorFromRequest(req);
  if (!actor) return Response.json({ error: "No autenticado." }, { status: 401 });
  const { id } = await ctx.params;
  if (!(await getPatient(id))) return Response.json({ error: "Paciente no encontrado." }, { status: 404 });
  const access = await checkAccess(actor, id);
  if (!access.ok) return Response.json({ error: access.error }, { status: access.status });
  return Response.json({ ok: true, patient: await ficha(id) });
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const actor = await actorFromRequest(req);
  if (!actor) return Response.json({ ok: false, error: "No autenticado." }, { status: 401 });
  if (actor.role === "paciente") {
    return Response.json({ ok: false, error: "La ficha la edita el consultorio." }, { status: 403 });
  }
  const { id } = await ctx.params;
  if (!(await getPatient(id))) return Response.json({ ok: false, error: "Paciente no encontrado." }, { status: 404 });
  const access = await checkAccess(actor, id);
  if (!access.ok) return Response.json({ ok: false, error: access.error }, { status: access.status });

  const body = (await req.json()) as PatientPatch;
  const patch: PatientPatch = {};
  for (const k of ["fullName", "dni", "dateOfBirth", "phone", "email", "coverage"] as const) {
    if (typeof body[k] === "string") patch[k] = body[k];
  }
  if (typeof body.notes === "string" || body.notes === null) patch.notes = body.notes;
  if (Array.isArray(body.allergies)) patch.allergies = body.allergies.map(String);
  if (Array.isArray(body.activeConditions)) patch.activeConditions = body.activeConditions.map(String);

  if (typeof patch.fullName === "string" && !patch.fullName.trim()) {
    return Response.json({ ok: false, error: "El nombre no puede quedar vacío." }, { status: 400 });
  }
  if (typeof patch.email === "string" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(patch.email.trim())) {
    return Response.json(
      { ok: false, error: "El email no puede quedar vacío ni inválido: es lo que valida el acceso del paciente." },
      { status: 400 },
    );
  }
  if (typeof patch.phone === "string" && patch.phone.replace(/\D/g, "").length < 8) {
    return Response.json(
      { ok: false, error: "El teléfono no puede quedar vacío: es lo que valida el acceso del paciente." },
      { status: 400 },
    );
  }
  if (typeof patch.dni === "string") {
    if (!patch.dni.trim()) {
      return Response.json({ ok: false, error: "El DNI no puede quedar vacío." }, { status: 400 });
    }
    const clash = await getPatientByDni(patch.dni);
    if (clash && clash.id !== id) {
      return Response.json({ ok: false, error: `Ya hay otro paciente con DNI ${patch.dni}.` }, { status: 409 });
    }
  }

  await updatePatient(id, patch);
  return Response.json({ ok: true, patient: await ficha(id) });
}
