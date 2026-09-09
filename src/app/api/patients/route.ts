import { createPatient, createPatientUser, getPatientByDni, userNameTaken } from "@/lib/db/repo";
import { hashPin } from "@/lib/auth/pin";
import { sessionSetCookie, signSession } from "@/lib/auth/session";
import type { Actor } from "@/lib/domain/types";

/**
 * Patient self-signup. Creates the patient record + a login and starts a
 * session. (Staff create patients through the agent's `registerPatient` tool.)
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
  };

  const fullName = body.fullName?.trim();
  const dni = body.dni?.trim();
  const dateOfBirth = body.dateOfBirth?.trim();
  const coverage = body.coverage?.trim();
  const pin = body.pin?.trim();

  if (!fullName || !dni || !dateOfBirth || !coverage || !pin || !/^\d{4}$/.test(pin)) {
    return Response.json(
      { ok: false, error: "Completá nombre, DNI, fecha de nacimiento, cobertura y un PIN de 4 dígitos." },
      { status: 400 },
    );
  }
  if (userNameTaken(fullName)) {
    return Response.json(
      { ok: false, error: "Ya existe un usuario con ese nombre. Probá iniciar sesión." },
      { status: 409 },
    );
  }
  if (getPatientByDni(dni)) {
    return Response.json(
      { ok: false, error: "Ya hay un paciente registrado con ese DNI. Contactá al consultorio." },
      { status: 409 },
    );
  }

  const patient = createPatient({
    fullName,
    dni,
    dateOfBirth,
    coverage,
    phone: body.phone,
    email: body.email,
    notes: "Alta por autogestión del paciente.",
  });
  const { hash, salt } = hashPin(pin);
  const user = createPatientUser({ name: fullName, pinHash: hash, pinSalt: salt, patientId: patient.id });

  const actor: Actor = {
    userId: user.id,
    name: user.name,
    role: "paciente",
    patientId: patient.id,
  };

  return Response.json(
    { ok: true, actor },
    { headers: { "Set-Cookie": sessionSetCookie(signSession(actor)) } },
  );
}
