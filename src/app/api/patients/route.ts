import {
  createPatient,
  createUser,
  getOrganization,
  getPatientByDni,
  getUserByPatientId,
  joinPatientOrg,
  normEmail,
  normPhone,
  patientInOrg,
  userEmailTaken,
} from "@/lib/db/repo";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** At least 8 digits once separators/prefixes are stripped. */
const phoneOk = (s: string) => s.replace(/\D/g, "").length >= 8;
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
  const phone = body.phone?.trim();
  const pin = body.pin?.trim();
  const org = body.organizationId ? getOrganization(body.organizationId) : undefined;

  if (
    !fullName || !dni || !dateOfBirth || !coverage || !email || !phone ||
    !pin || !/^\d{4}$/.test(pin) || !org
  ) {
    return Response.json(
      { ok: false, error: "Completá tus datos, email, teléfono, elegí un consultorio y un PIN de 4 dígitos." },
      { status: 400 },
    );
  }
  if (!EMAIL_RE.test(email)) {
    return Response.json({ ok: false, error: "El email no parece válido." }, { status: 400 });
  }
  if (!phoneOk(phone)) {
    return Response.json({ ok: false, error: "El teléfono no parece válido." }, { status: 400 });
  }
  if (userEmailTaken(email)) {
    return Response.json(
      { ok: false, error: "Ya hay una cuenta con ese email. Probá iniciar sesión." },
      { status: 409 },
    );
  }

  let patient = getPatientByDni(dni);
  if (patient) {
    // A ficha for this DNI already exists. It may only be claimed by someone who
    // can prove they are that person — the email AND phone must match what the
    // clinic already has on file. Otherwise this endpoint would let anyone bind
    // a fresh login to a stranger's clinical record using just their DNI.
    if (getUserByPatientId(patient.id)) {
      return Response.json(
        { ok: false, error: "Ya existe una cuenta para ese DNI. Iniciá sesión o recuperá tu PIN." },
        { status: 409 },
      );
    }
    if (!patient.email || !patient.phone) {
      return Response.json(
        {
          ok: false,
          error:
            "Tu ficha todavía no tiene email y teléfono registrados. Pedile al consultorio que los cargue para activar tu acceso.",
        },
        { status: 409 },
      );
    }
    if (normEmail(patient.email) !== normEmail(email) || normPhone(patient.phone) !== normPhone(phone)) {
      return Response.json(
        {
          ok: false,
          error:
            "El email y el teléfono no coinciden con los de tu ficha. Verificalos o pedí ayuda en el consultorio.",
        },
        { status: 403 },
      );
    }
  } else {
    patient = createPatient({
      fullName,
      dni,
      dateOfBirth,
      coverage,
      phone,
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
  const email = body.email?.trim().toLowerCase();
  const phone = body.phone?.trim();
  // Email + phone are mandatory: they are what lets the patient later claim their
  // portal login and recover their PIN, and the only identity anchor we can check
  // against when they do.
  if (!fullName || !dni || !dateOfBirth || !coverage || !email || !phone) {
    return Response.json(
      {
        ok: false,
        error: "Completá nombre, DNI, fecha de nacimiento (AAAA-MM-DD), cobertura, email y teléfono.",
      },
      { status: 400 },
    );
  }
  if (!EMAIL_RE.test(email)) {
    return Response.json({ ok: false, error: "El email no parece válido." }, { status: 400 });
  }
  if (!phoneOk(phone)) {
    return Response.json({ ok: false, error: "El teléfono no parece válido." }, { status: 400 });
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
    phone,
    email,
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
