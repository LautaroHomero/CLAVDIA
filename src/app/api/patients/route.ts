import {
  createPatient,
  createUser,
  getOrganization,
  getPatientByDni,
  joinPatientOrg,
  userNameTaken,
} from "@/lib/db/repo";
import { hashPin } from "@/lib/auth/pin";
import { hydrateActor } from "@/lib/auth/actor";
import { sessionSetCookie, signSession } from "@/lib/auth/session";

/**
 * Patient self-signup. Creates the global ficha + a login, joins the chosen
 * organization, and starts a session. (Staff create patients via the agent's
 * `registerPatient` tool.)
 */
export async function POST(req: Request) {
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
  const pin = body.pin?.trim();
  const org = body.organizationId ? getOrganization(body.organizationId) : undefined;

  if (!fullName || !dni || !dateOfBirth || !coverage || !pin || !/^\d{4}$/.test(pin) || !org) {
    return Response.json(
      { ok: false, error: "Completá tus datos, elegí un consultorio y un PIN de 4 dígitos." },
      { status: 400 },
    );
  }
  if (userNameTaken(fullName)) {
    return Response.json(
      { ok: false, error: "Ya existe un usuario con ese nombre. Probá iniciar sesión." },
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
      email: body.email,
      notes: "Alta por autogestión del paciente.",
    });
  }
  joinPatientOrg(patient.id, org.id);

  const { hash, salt } = hashPin(pin);
  const user = createUser({ name: fullName, role: "paciente", pinHash: hash, pinSalt: salt, patientId: patient.id });

  const claims = { userId: user.id, role: "paciente" as const, patientId: patient.id };
  return Response.json(
    { ok: true, actor: hydrateActor(claims) },
    { headers: { "Set-Cookie": sessionSetCookie(signSession(claims)) } },
  );
}
