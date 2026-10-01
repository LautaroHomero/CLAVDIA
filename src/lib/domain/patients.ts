/**
 * Single implementation of "resolve a patient by DNI, or create a new ficha" —
 * used by the agent tool (`registerPatient` in
 * `src/workflows/secretary/tools.ts`), the staff REST endpoint
 * (`staffCreateOrJoin` in `src/app/api/patients/route.ts`), and the "brand new
 * patient" branch of patient self-signup (same file, unauthenticated POST).
 *
 * DNI is the identity anchor for the whole platform (one ficha per person,
 * shared across organizaciones), so this module is the only place that
 * decides whether a DNI is well-formed and whether a ficha already exists for
 * it. Authorization (role / org membership) stays each caller's job — this
 * module only validates patient data and touches patients/logins.
 */
import {
  createPatient,
  ensurePatientLogin,
  getPatientByDni,
  joinPatientOrg,
  patientInOrg,
  userEmailTaken,
} from "@/lib/db/repo";
import type { Patient } from "@/lib/domain/types";

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function emailLooksValid(email: string): boolean {
  return EMAIL_RE.test(email.trim());
}

/** At least 8 digits once separators/prefixes are stripped. */
export function phoneLooksValid(phone: string): boolean {
  return phone.replace(/\D/g, "").length >= 8;
}

/** DNI, ignoring dots and spaces — same normalisation `getPatientByDni` uses. */
export function normalizeDni(dni: string): string {
  return dni.replace(/[.\s]/g, "");
}

export function dniLooksValid(dni: string): boolean {
  return /^\d{7,8}$/.test(normalizeDni(dni));
}

export const DNI_INVALID_ERROR = "El DNI no parece válido. Revisá que tenga 7 u 8 dígitos.";

export interface ResolveOrCreatePatientInput {
  dni: string;
  fullName?: string;
  dateOfBirth?: string;
  coverage?: string;
  phone?: string;
  email?: string;
  notes?: string;
}

export type ResolveOrCreatePatientResult =
  | { ok: true; patient: Patient; alreadyExisted: boolean; alreadyInOrg: boolean }
  | { ok: false; status: number; error: string };

/**
 * DNI known → the existing ficha is just linked to `orgId` (plus a login if
 * it doesn't have one yet). No other field of `input` is applied, even if the
 * caller sent one — editing a ficha is a separate, explicit action.
 * DNI unknown → a full ficha is required (name, birth date, coverage, valid
 * email and phone), and a login is created for it.
 */
export async function resolveOrCreatePatient(
  input: ResolveOrCreatePatientInput,
  orgId: string,
): Promise<ResolveOrCreatePatientResult> {
  const dni = input.dni?.trim();
  if (!dni) return { ok: false, status: 400, error: "Indicá el DNI del paciente." };
  if (!dniLooksValid(dni)) {
    return { ok: false, status: 400, error: DNI_INVALID_ERROR };
  }

  const existing = await getPatientByDni(dni);
  if (existing) {
    const alreadyInOrg = await patientInOrg(existing.id, orgId);
    if (!alreadyInOrg) await joinPatientOrg(existing.id, orgId);
    await ensurePatientLogin({
      patientId: existing.id,
      name: existing.fullName,
      email: existing.email,
      dni: existing.dni,
      phone: existing.phone,
    });
    return { ok: true, patient: existing, alreadyExisted: true, alreadyInOrg };
  }

  // New patient → full data required.
  const fullName = input.fullName?.trim();
  const dateOfBirth = input.dateOfBirth?.trim();
  const coverage = input.coverage?.trim();
  const email = (input.email ?? "").trim().toLowerCase();
  const phone = (input.phone ?? "").trim();

  if (!fullName || !dateOfBirth || !coverage) {
    return { ok: false, status: 400, error: "Paciente nuevo: pedí nombre, fecha de nacimiento (AAAA-MM-DD) y cobertura." };
  }
  if (!emailLooksValid(email)) {
    return { ok: false, status: 400, error: "Pedí un email válido: es lo que usa el paciente para recuperar su PIN." };
  }
  if (!phoneLooksValid(phone)) {
    return { ok: false, status: 400, error: "Pedí un teléfono válido para el paciente." };
  }
  if (await userEmailTaken(email)) {
    return {
      ok: false,
      status: 409,
      error: "Ya hay una cuenta con ese email. Verificalo o iniciá sesión con esa cuenta.",
    };
  }

  const patient = await createPatient({
    fullName,
    dni,
    dateOfBirth,
    coverage,
    phone,
    email,
    notes: input.notes,
  });
  await joinPatientOrg(patient.id, orgId);
  await ensurePatientLogin({ patientId: patient.id, name: fullName, email, dni, phone });
  return { ok: true, patient, alreadyExisted: false, alreadyInOrg: false };
}
