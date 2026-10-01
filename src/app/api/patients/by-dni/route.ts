import { actorFromRequest } from "@/lib/auth/actor";
import { getPatientByDni } from "@/lib/db/repo";
import { DNI_INVALID_ERROR, dniLooksValid } from "@/lib/domain/patients";

/**
 * Staff-only lookup used by the "Sistema" alta form to be DNI-first: before
 * asking for the rest of the ficha, check whether this DNI already has one
 * (global lookup — a patient's ficha is shared across organizaciones).
 */
export async function GET(req: Request) {
  const actor = await actorFromRequest(req);
  if (!actor) return Response.json({ error: "No autenticado." }, { status: 401 });
  if (actor.role === "paciente") {
    return Response.json({ error: "Solo personal del consultorio." }, { status: 403 });
  }

  const dni = (new URL(req.url).searchParams.get("dni") ?? "").trim();
  if (!dni) return Response.json({ error: "Indicá el DNI." }, { status: 400 });
  if (!dniLooksValid(dni)) return Response.json({ error: DNI_INVALID_ERROR }, { status: 400 });

  const patient = await getPatientByDni(dni);
  return Response.json({
    ok: true,
    exists: Boolean(patient),
    patient: patient
      ? { patientId: patient.id, fullName: patient.fullName, dni: patient.dni, coverage: patient.coverage }
      : null,
  });
}
