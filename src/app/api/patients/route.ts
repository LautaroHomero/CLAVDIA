import {
  createPatient,
  createUser,
  getOrganization,
  getPatientByDni,
  joinPatientOrg,
  patientInOrg,
  userEmailTaken,
} from "@/lib/db/repo";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
import { hashPin } from "@/lib/auth/pin";
import { actorFromRequest, hydrateActor } from "@/lib/auth/actor";
import { sessionSetCookie, signSession } from "@/lib/auth/session";
import type { Actor } from "@/lib/domain/types";

/**
 * Two callers:
 *  - Authenticated staff (médico / recepción): create a ficha in their active
 *    organization, or — if that DNI already exists (incl. a self-registered
 *    patient) — just add that patient to the organization. No portal login.
 *  - Unauthenticated patient self-signup: create the global ficha + a login,
 *    join the chosen organization, and start a session.
 */
export async function POST(req: Request) {
  const actor = actorFromRequest(req);
  if (actor && actor.role !== "paciente") return staffCreateOrJoin(req, actor);

  const body = (await req.json()) as {
    fullName?: string;
    dni?: string;
    dateOfBirth?: string;
    coverage?: string;
    phone?: string;
    email?: string;
    pin?: string;
    organizationId?: string;
  };

  const fullName = body.fullName?.trim();
  const dni = body.dni?.trim();
  const dateOfBirth = body.dateOfBirth?.trim();
  const coverage = body.coverage?.trim();
  const email = body.email?.trim().toLowerCase();
  const pin = body.pin?.trim();
  const org = body.organizationId ? getOrganization(body.organizationId) : undefined;

  if (!fullName || !dni || !dateOfBirth || !coverage || !email || !pin || !/^\d{4}$/.test(pin) || !org) {
    return Response.json(
      { ok: false, error: "Completá tus datos, tu email, elegí un consultorio y un PIN de 4 dígitos." },
      { status: 400 },
    );
  }
  if (!EMAIL_RE.test(email)) {
    return Response.json({ ok: false, error: "El email no parece válido." }, { status: 400 });
  }
  if (userEmailTaken(email)) {
    return Response.json(
      { ok: false, error: "Ya hay una cuenta con ese email. Probá iniciar sesión." },
      { status: 409 },
    );
  }

  let patient = getPatientByDni(dni);
  if (!patient) {
    patient = createPatient({
      fullName,
      dni,
      dateOfBirth,
      coverage,
      phone: body.phone,
      email,
      notes: "Alta por autogestión del paciente.",
    });
  }
  joinPatientOrg(patient.id, org.id);

  const { hash, salt } = hashPin(pin);
  const user = createUser({ name: fullName, email, role: "paciente", pinHash: hash, pinSalt: salt, patientId: patient.id });

  const claims = { userId: user.id, role: "paciente" as const, patientId: patient.id };
  return Response.json(
    { ok: true, actor: hydrateActor(claims) },
    { headers: { "Set-Cookie": sessionSetCookie(signSession(claims)) } },
  );
}

async function staffCreateOrJoin(req: Request, actor: Actor) {
  const orgId = actor.activeOrg?.id;
  if (!orgId) return Response.json({ ok: false, error: "Sin organización activa." }, { status: 400 });
  const orgName = actor.activeOrg?.name ?? "este consultorio";

  const body = (await req.json()) as {
    fullName?: string;
    dni?: string;
    dateOfBirth?: string;
    coverage?: string;
    phone?: string;
    email?: string;
    notes?: string;
  };
  const fullName = body.fullName?.trim();
  const dni = body.dni?.trim();
  const dateOfBirth = body.dateOfBirth?.trim();
  const coverage = body.coverage?.trim();
  if (!fullName || !dni || !dateOfBirth || !coverage) {
    return Response.json(
      { ok: false, error: "Completá nombre, DNI, fecha de nacimiento (AAAA-MM-DD) y cobertura." },
      { status: 400 },
    );
  }

  const existing = getPatientByDni(dni);
  if (existing) {
    const alreadyHere = patientInOrg(existing.id, orgId);
    if (!alreadyHere) joinPatientOrg(existing.id, orgId);
    return Response.json({
      ok: true,
      patientId: existing.id,
      alreadyExisted: true,
      message: alreadyHere
        ? `${existing.fullName} (DNI ${existing.dni}) ya era paciente de ${orgName}.`
        : `${existing.fullName} (DNI ${existing.dni}) ya tenía ficha; lo/la sumamos a ${orgName}.`,
    });
  }

  const patient = createPatient({
    fullName,
    dni,
    dateOfBirth,
    coverage,
    phone: body.phone,
    email: body.email,
    notes: body.notes,
  });
  joinPatientOrg(patient.id, orgId);
  return Response.json({
    ok: true,
    patientId: patient.id,
    alreadyExisted: false,
    fullName: patient.fullName,
    message: `Ficha creada en ${orgName}.`,
  });
}
