import {
  createPatient,
  createUser,
  getOrganization,
  getPatientByDni,
  getUserByPatientId,
  joinPatientOrg,
  normEmail,
  normPhone,
  userEmailTaken,
} from "@/lib/db/repo";
import {
  DNI_INVALID_ERROR,
  dniLooksValid,
  emailLooksValid,
  phoneLooksValid,
  resolveOrCreatePatient,
} from "@/lib/domain/patients";
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
  if (!dniLooksValid(dni)) {
    return Response.json({ ok: false, error: DNI_INVALID_ERROR }, { status: 400 });
  }
  if (!emailLooksValid(email)) {
    return Response.json({ ok: false, error: "El email no parece válido." }, { status: 400 });
  }
  if (!phoneLooksValid(phone)) {
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

  const result = await resolveOrCreatePatient(
    {
      dni: body.dni ?? "",
      fullName: body.fullName,
      dateOfBirth: body.dateOfBirth,
      coverage: body.coverage,
      phone: body.phone,
      email: body.email,
      notes: body.notes,
    },
    orgId,
  );
  if (!result.ok) return Response.json({ ok: false, error: result.error }, { status: result.status });

  const { patient, alreadyExisted, alreadyInOrg } = result;
  return Response.json({
    ok: true,
    patientId: patient.id,
    alreadyExisted,
    fullName: patient.fullName,
    dni: patient.dni,
    message: alreadyExisted
      ? alreadyInOrg
        ? `${patient.fullName} (DNI ${patient.dni}) ya era paciente de ${orgName}.`
        : `${patient.fullName} (DNI ${patient.dni}) ya estaba en el sistema; lo/la sumamos a ${orgName}.`
      : `Ficha creada en ${orgName}. Puede entrar con su DNI o email y "Olvidé mi PIN" para elegir su PIN.`,
  });
}
