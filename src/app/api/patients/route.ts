import {
  createPatient,
  createUser,
  ensurePatientLogin,
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
  const actor = await actorFromRequest(req);
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
  const org = body.organizationId ? await getOrganization(body.organizationId) : undefined;

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
  if (await userEmailTaken(email)) {
    return Response.json(
      { ok: false, error: "Ya hay una cuenta con ese email. Probá iniciar sesión." },
      { status: 409 },
    );
  }

  let patient = await getPatientByDni(dni);
  if (patient) {
    // A ficha for this DNI already exists. It may only be claimed by someone who
    // can prove they are that person — the email AND phone must match what the
    // clinic already has on file. Otherwise this endpoint would let anyone bind
    // a fresh login to a stranger's clinical record using just their DNI.
    if (await getUserByPatientId(patient.id)) {
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
    patient = await createPatient({
      fullName,
      dni,
      dateOfBirth,
      coverage,
      phone,
      email,
      notes: "Alta por autogestión del paciente.",
    });
  }
  await joinPatientOrg(patient.id, org.id);

  const { hash, salt } = hashPin(pin);
  const user = await createUser({ name: fullName, email, role: "paciente", pinHash: hash, pinSalt: salt, patientId: patient.id });

  const claims = { userId: user.id, role: "paciente" as const, patientId: patient.id };
  return Response.json(
    { ok: true, actor: await hydrateActor(claims) },
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
  const dni = body.dni?.trim();
  if (!dni) {
    return Response.json({ ok: false, error: "Indicá el DNI." }, { status: 400 });
  }

  // Already in the system → just link to this org (DNI is enough, no re-entry).
  const existing = await getPatientByDni(dni);
  if (existing) {
    const alreadyHere = await patientInOrg(existing.id, orgId);
    if (!alreadyHere) await joinPatientOrg(existing.id, orgId);
    await ensurePatientLogin({
      patientId: existing.id,
      name: existing.fullName,
      email: existing.email,
      dni: existing.dni,
      phone: existing.phone,
    });
    return Response.json({
      ok: true,
      patientId: existing.id,
      alreadyExisted: true,
      message: alreadyHere
        ? `${existing.fullName} (DNI ${existing.dni}) ya era paciente de ${orgName}.`
        : `${existing.fullName} (DNI ${existing.dni}) ya estaba en el sistema; lo/la sumamos a ${orgName}.`,
    });
  }

  // New person → full data required (email + phone are the recovery anchors).
  const fullName = body.fullName?.trim();
  const dateOfBirth = body.dateOfBirth?.trim();
  const coverage = body.coverage?.trim();
  const email = body.email?.trim().toLowerCase();
  const phone = body.phone?.trim();
  if (!fullName || !dateOfBirth || !coverage || !email || !phone) {
    return Response.json(
      {
        ok: false,
        error: "Paciente nuevo: completá nombre, fecha de nacimiento (AAAA-MM-DD), cobertura, email y teléfono.",
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

  const patient = await createPatient({ fullName, dni, dateOfBirth, coverage, phone, email, notes: body.notes });
  await joinPatientOrg(patient.id, orgId);
  await ensurePatientLogin({ patientId: patient.id, name: fullName, email, dni, phone });
  return Response.json({
    ok: true,
    patientId: patient.id,
    alreadyExisted: false,
    fullName: patient.fullName,
    message: `Ficha creada en ${orgName}. Puede entrar con su DNI o email y "Olvidé mi PIN" para elegir su PIN.`,
  });
}
