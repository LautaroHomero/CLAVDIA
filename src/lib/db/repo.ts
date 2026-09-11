import { randomUUID } from "node:crypto";
import type {
  Appointment,
  AppointmentChangeRequest,
  ChangeRequestKind,
  ChangeRequestStatus,
  Invoice,
  LabResult,
  Medication,
  OrgRef,
  Organization,
  Patient,
  PatientMessage,
  PrescriptionRequest,
  PriceItem,
  Provider,
  ProviderSettings,
  Role,
  Slot,
  StaffRole,
  User,
} from "@/lib/domain/types";
import { DEMO_TODAY } from "@/lib/domain/clock";
import { getSql } from "./connection";
import { generateSlotRows } from "./slots";

const TODAY = DEMO_TODAY;
type Row = Record<string, unknown>;
const uid = (p: string) => `${p}_${randomUUID().slice(0, 8)}`;

// ---------------------------------------------------------------------------
// Row mappers
// ---------------------------------------------------------------------------

const toProvider = (r: Row): Provider => ({
  id: r.id as string,
  organizationId: r.organization_id as string,
  name: r.name as string,
  specialty: r.specialty as string,
  roomLabel: r.room_label as string,
  defaultFee: Number(r.default_fee ?? 0),
  active: Boolean(r.active ?? true),
});

const toMedication = (r: Row): Medication => ({
  name: r.name as string,
  dose: r.dose as string,
  lastPrescribed: r.last_prescribed as string,
  chronic: Boolean(r.chronic),
});

const toPatient = (r: Row, meds: Medication[]): Patient => ({
  id: r.id as string,
  fullName: r.full_name as string,
  dni: r.dni as string,
  dateOfBirth: r.date_of_birth as string,
  phone: r.phone as string,
  email: r.email as string,
  coverage: r.coverage as string,
  allergies: JSON.parse((r.allergies as string) || "[]"),
  activeConditions: JSON.parse((r.active_conditions as string) || "[]"),
  medications: meds,
  notes: (r.notes as string) ?? undefined,
});

const toAppointment = (r: Row): Appointment => ({
  id: r.id as string,
  organizationId: r.organization_id as string,
  patientId: r.patient_id as string,
  providerId: r.provider_id as string,
  start: r.start as string,
  durationMinutes: Number(r.duration_minutes),
  reason: r.reason as string,
  status: r.status as Appointment["status"],
  price: Number(r.price ?? 0),
  actualStart: (r.actual_start as string) ?? undefined,
  actualEnd: (r.actual_end as string) ?? undefined,
  createdVia: r.created_via as Appointment["createdVia"],
});

const toSlot = (r: Row): Slot => ({
  id: r.id as string,
  providerId: r.provider_id as string,
  start: r.start as string,
  durationMinutes: Number(r.duration_minutes),
  taken: Boolean(r.taken),
});

const toInvoice = (r: Row): Invoice => ({
  id: r.id as string,
  organizationId: r.organization_id as string,
  patientId: r.patient_id as string,
  date: r.date as string,
  concept: r.concept as string,
  amount: Number(r.amount),
  status: r.status as Invoice["status"],
});

const toLab = (r: Row): LabResult => ({
  id: r.id as string,
  patientId: r.patient_id as string,
  date: r.date as string,
  panel: r.panel as string,
  status: r.status as LabResult["status"],
  summary: r.summary as string,
});

// ---------------------------------------------------------------------------
// Organizations
// ---------------------------------------------------------------------------

const toOrg = (r: Row): Organization => ({
  id: r.id as string,
  name: r.name as string,
  slug: r.slug as string,
  address: r.address as string,
  city: (r.city as string) ?? "",
  hours: r.hours as string,
  phone: r.phone as string,
});

export async function listOrganizations(): Promise<Organization[]> {
  const rows = (await getSql()`SELECT * FROM organizations ORDER BY name`) as unknown as Row[];
  return rows.map(toOrg);
}

export async function getOrganization(id: string): Promise<Organization | undefined> {
  const [r] = (await getSql()`SELECT * FROM organizations WHERE id = ${id}`) as unknown as Row[];
  return r ? toOrg(r) : undefined;
}

function normName(s: string): string {
  return s.trim().toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
}

function slugify(s: string): string {
  return normName(s).replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "org";
}

export async function createOrganization(input: {
  name: string;
  address?: string;
  city?: string;
  phone?: string;
  hours?: string;
}): Promise<Organization> {
  const sql = getSql();
  let slug = slugify(input.name);
  const [taken] = (await sql`SELECT 1 FROM organizations WHERE slug = ${slug}`) as unknown as Row[];
  if (taken) slug = `${slug}-${uid("").slice(1, 5)}`;
  const id = uid("org");
  await sql`
    INSERT INTO organizations (id, name, slug, address, city, hours, phone, created_at)
    VALUES (${id}, ${input.name.trim()}, ${slug}, ${input.address?.trim() ?? ""}, ${input.city?.trim() ?? ""},
            ${input.hours?.trim() || "Lunes a viernes de 8 a 18 h"}, ${input.phone?.trim() ?? ""}, ${new Date().toISOString()})`;
  return (await getOrganization(id))!;
}

export async function organizationNameTaken(name: string): Promise<boolean> {
  const t = normName(name);
  const rows = (await getSql()`SELECT name FROM organizations`) as unknown as Row[];
  return rows.some((r) => normName(r.name as string) === t);
}

// ---------------------------------------------------------------------------
// Users, memberships, auth
// ---------------------------------------------------------------------------

const toUser = (r: Row): User => ({
  id: r.id as string,
  name: r.name as string,
  email: (r.email as string) ?? "",
  dni: (r.dni as string) ?? "",
  phone: (r.phone as string) ?? "",
  role: r.role as Role,
  patientId: (r.patient_id as string) ?? undefined,
});

export interface Membership {
  organizationId: string;
  organizationName: string;
  role: StaffRole;
  providerId?: string;
  specialty?: string;
  canAdmin: boolean;
}

export async function membershipsForUser(userId: string): Promise<Membership[]> {
  const rows = (await getSql()`
    SELECT m.organization_id, o.name AS org_name, m.role, m.provider_id, m.can_admin, p.specialty
    FROM memberships m
    JOIN organizations o ON o.id = m.organization_id
    LEFT JOIN providers p ON p.id = m.provider_id
    WHERE m.user_id = ${userId}
    ORDER BY o.name`) as unknown as Row[];
  return rows.map((r) => ({
    organizationId: r.organization_id as string,
    organizationName: r.org_name as string,
    role: r.role as StaffRole,
    providerId: (r.provider_id as string) ?? undefined,
    specialty: (r.specialty as string) ?? undefined,
    // secretaría always administers; a médico only if flagged (org founder).
    canAdmin: Boolean(r.can_admin) || (r.role as StaffRole) === "recepcion",
  }));
}

export async function patientOrgs(patientId: string): Promise<OrgRef[]> {
  const rows = (await getSql()`
    SELECT o.id, o.name FROM patient_organizations po
    JOIN organizations o ON o.id = po.organization_id
    WHERE po.patient_id = ${patientId} ORDER BY o.name`) as unknown as Row[];
  return rows.map((r) => ({ id: r.id as string, name: r.name as string }));
}

export async function joinPatientOrg(patientId: string, organizationId: string): Promise<void> {
  await getSql()`
    INSERT INTO patient_organizations (patient_id, organization_id, joined_at)
    VALUES (${patientId}, ${organizationId}, ${new Date().toISOString()})
    ON CONFLICT DO NOTHING`;
}

export const normEmail = (s: string): string => s.trim().toLowerCase();

/** Digits only, trailing 8 — tolerant of +54 / 0 / 15 / area-code variations. */
export const normPhone = (s: string): string => s.replace(/\D/g, "").slice(-8);

/** The portal login bound to a patient record, if one has been claimed. */
export async function getUserByPatientId(patientId: string): Promise<User | undefined> {
  const [r] = (await getSql()`SELECT * FROM users WHERE patient_id = ${patientId}`) as unknown as Row[];
  return r ? toUser(r) : undefined;
}

export async function getUserByName(
  name: string,
): Promise<(User & { pinHash: string; pinSalt: string }) | undefined> {
  const target = normName(name);
  const rows = (await getSql()`SELECT * FROM users`) as unknown as Row[];
  const r = rows.find((row) => normName(row.name as string) === target);
  if (!r) return undefined;
  return { ...toUser(r), pinHash: r.pin_hash as string, pinSalt: r.pin_salt as string };
}

/** Primary login lookup — email is the identifier for every role. */
export async function getUserByEmail(
  email: string,
): Promise<(User & { pinHash: string; pinSalt: string }) | undefined> {
  const target = normEmail(email);
  if (!target) return undefined;
  const rows = (await getSql()`SELECT * FROM users`) as unknown as Row[];
  const r = rows.find((row) => normEmail((row.email as string) ?? "") === target);
  if (!r) return undefined;
  return { ...toUser(r), pinHash: r.pin_hash as string, pinSalt: r.pin_salt as string };
}

export async function getUser(id: string): Promise<User | undefined> {
  const [r] = (await getSql()`SELECT * FROM users WHERE id = ${id}`) as unknown as Row[];
  return r ? toUser(r) : undefined;
}

export async function userNameTaken(name: string): Promise<boolean> {
  const t = normName(name);
  const rows = (await getSql()`SELECT name FROM users`) as unknown as Row[];
  return rows.some((r) => normName(r.name as string) === t);
}

export async function userEmailTaken(email: string): Promise<boolean> {
  const t = normEmail(email);
  const rows = (await getSql()`SELECT email FROM users`) as unknown as Row[];
  return rows.some((r) => normEmail((r.email as string) ?? "") === t);
}

export async function createUser(args: {
  name: string;
  email: string;
  role: Role;
  /** "" leaves the account without a usable PIN — the person sets it via recovery. */
  pinHash: string;
  pinSalt: string;
  dni?: string;
  phone?: string;
  patientId?: string;
}): Promise<User> {
  const id = uid("u");
  const email = normEmail(args.email);
  const dni = (args.dni ?? "").trim();
  const phone = (args.phone ?? "").trim();
  await getSql()`
    INSERT INTO users (id, name, email, dni, phone, role, pin_hash, pin_salt, patient_id)
    VALUES (${id}, ${args.name.trim()}, ${email}, ${dni}, ${phone}, ${args.role}, ${args.pinHash}, ${args.pinSalt}, ${args.patientId ?? null})`;
  return { id, name: args.name.trim(), email, dni, phone, role: args.role, patientId: args.patientId };
}

const bareDni = (s: string) => s.replace(/\D/g, "");

/** True when the account has a PIN set (recovery flow fills it in the first time). */
export const hasUsablePin = (u: { pinHash?: string } | undefined): boolean => !!u?.pinHash;

/** Any login (any role) whose DNI matches, plus its PIN material. */
export async function getUserByDni(
  dni: string,
): Promise<(User & { pinHash: string; pinSalt: string }) | undefined> {
  const target = bareDni(dni);
  if (!target) return undefined;
  const sql = getSql();
  const rows = (await sql`SELECT * FROM users`) as unknown as Row[];
  const r = rows.find((row) => bareDni((row.dni as string) ?? "") === target);
  if (r) return { ...toUser(r), pinHash: r.pin_hash as string, pinSalt: r.pin_salt as string };
  // Fallback for patient logins created before users.dni existed.
  const p = await getPatientByDni(dni);
  if (!p) return undefined;
  const [pr] = (await sql`SELECT * FROM users WHERE patient_id = ${p.id}`) as unknown as Row[];
  return pr ? { ...toUser(pr), pinHash: pr.pin_hash as string, pinSalt: pr.pin_salt as string } : undefined;
}

/**
 * Ensure the patient behind `patientId` has a portal login. No-op if one exists.
 * The account starts without a PIN — the patient sets it through recovery using
 * the email / phone the clinic loaded.
 */
export async function ensurePatientLogin(args: {
  patientId: string;
  name: string;
  email: string;
  dni: string;
  phone: string;
}): Promise<User> {
  const existing = await getUserByPatientId(args.patientId);
  if (existing) return existing;
  return createUser({
    name: args.name,
    email: args.email,
    role: "paciente",
    pinHash: "",
    pinSalt: "",
    dni: args.dni,
    phone: args.phone,
    patientId: args.patientId,
  });
}

export async function updateUserPin(userId: string, pin: { hash: string; salt: string }): Promise<void> {
  await getSql()`UPDATE users SET pin_hash = ${pin.hash}, pin_salt = ${pin.salt} WHERE id = ${userId}`;
}

/** Resolve a login (any role) from an email or a DNI. */
export async function findLogin(args: { email?: string; dni?: string }): Promise<User | undefined> {
  const raw = (args.email ?? args.dni ?? "").trim();
  if (!raw) return undefined;
  const hit = raw.includes("@") ? await getUserByEmail(raw) : await getUserByDni(raw);
  if (!hit) return undefined;
  return { id: hit.id, name: hit.name, email: hit.email, dni: hit.dni, phone: hit.phone, role: hit.role, patientId: hit.patientId };
}

// ---------------------------------------------------------------------------
// One-time PIN-recovery codes
// ---------------------------------------------------------------------------

export type PinResetCode = {
  id: string;
  userId: string;
  codeHash: string;
  codeSalt: string;
  channel: string;
  sentTo: string;
  attempts: number;
  createdAt: string;
  expiresAt: string;
  consumedAt: string | null;
};

const toPinResetCode = (r: Row): PinResetCode => ({
  id: r.id as string,
  userId: r.user_id as string,
  codeHash: r.code_hash as string,
  codeSalt: r.code_salt as string,
  channel: r.channel as string,
  sentTo: r.sent_to as string,
  attempts: Number(r.attempts),
  createdAt: r.created_at as string,
  expiresAt: r.expires_at as string,
  consumedAt: (r.consumed_at as string) ?? null,
});

/** Invalidates any earlier outstanding code for the user, then stores the new one. */
export async function createPinResetCode(args: {
  userId: string;
  codeHash: string;
  codeSalt: string;
  channel: string;
  sentTo: string;
  ttlMinutes: number;
}): Promise<PinResetCode> {
  const sql = getSql();
  const now = new Date();
  await sql`UPDATE pin_reset_codes SET consumed_at = ${now.toISOString()} WHERE user_id = ${args.userId} AND consumed_at IS NULL`;
  const id = uid("prc");
  const expires = new Date(now.getTime() + args.ttlMinutes * 60_000);
  await sql`
    INSERT INTO pin_reset_codes (id, user_id, code_hash, code_salt, channel, sent_to, attempts, created_at, expires_at)
    VALUES (${id}, ${args.userId}, ${args.codeHash}, ${args.codeSalt}, ${args.channel}, ${args.sentTo}, 0, ${now.toISOString()}, ${expires.toISOString()})`;
  const [r] = (await sql`SELECT * FROM pin_reset_codes WHERE id = ${id}`) as unknown as Row[];
  return toPinResetCode(r);
}

/** The user's most recent still-valid (unconsumed, unexpired) code, if any. */
export async function activePinResetCode(userId: string): Promise<PinResetCode | undefined> {
  const [r] = (await getSql()`
    SELECT * FROM pin_reset_codes
    WHERE user_id = ${userId} AND consumed_at IS NULL AND expires_at > ${new Date().toISOString()}
    ORDER BY created_at DESC LIMIT 1`) as unknown as Row[];
  return r ? toPinResetCode(r) : undefined;
}

export async function bumpPinResetAttempts(id: string): Promise<number> {
  const [r] = (await getSql()`
    UPDATE pin_reset_codes SET attempts = attempts + 1 WHERE id = ${id} RETURNING attempts`) as unknown as Row[];
  return Number(r?.attempts ?? 0);
}

export async function consumePinResetCode(id: string): Promise<void> {
  await getSql()`UPDATE pin_reset_codes SET consumed_at = ${new Date().toISOString()} WHERE id = ${id}`;
}

export async function addMembership(args: {
  userId: string;
  organizationId: string;
  role: StaffRole;
  providerId?: string;
  canAdmin?: boolean;
}): Promise<void> {
  await getSql()`
    INSERT INTO memberships (user_id, organization_id, role, provider_id, can_admin)
    VALUES (${args.userId}, ${args.organizationId}, ${args.role}, ${args.providerId ?? null}, ${args.canAdmin ? 1 : 0})
    ON CONFLICT (user_id, organization_id)
    DO UPDATE SET role = EXCLUDED.role, provider_id = EXCLUDED.provider_id, can_admin = EXCLUDED.can_admin`;
}

// ---------------------------------------------------------------------------
// Providers (per org)
// ---------------------------------------------------------------------------

export async function listProviders(
  orgId: string,
  opts: { activeOnly?: boolean } = {},
): Promise<Provider[]> {
  const rows = (await getSql()`
    SELECT * FROM providers
    WHERE organization_id = ${orgId}
      AND (${opts.activeOnly ?? false} = false OR active = true)
    ORDER BY name`) as unknown as Row[];
  return rows.map(toProvider);
}

export async function getProvider(id: string): Promise<Provider | undefined> {
  const [r] = (await getSql()`SELECT * FROM providers WHERE id = ${id}`) as unknown as Row[];
  return r ? toProvider(r) : undefined;
}

/**
 * Dar de baja / reactivar un profesional. No borra nada: un profesional
 * inactivo deja de ofrecer turnos nuevos (ver `listOpenSlots`) pero su
 * historial (turnos, facturas, informes) sigue intacto y visible.
 */
export async function setProviderActive(id: string, active: boolean): Promise<void> {
  await getSql()`UPDATE providers SET active = ${active} WHERE id = ${id}`;
}

// ---------------------------------------------------------------------------
// Provider settings — per-professional policy for MANUAL appointment changes
// ---------------------------------------------------------------------------

const DEFAULT_PROVIDER_SETTINGS: ProviderSettings = {
  whoCanChange: "anyone",
  lateChangePolicy: "direct",
};

export async function getProviderSettings(providerId: string): Promise<ProviderSettings> {
  const [r] = (await getSql()`
    SELECT who_can_change, late_change_policy FROM provider_settings WHERE provider_id = ${providerId}`) as unknown as Row[];
  if (!r) return { ...DEFAULT_PROVIDER_SETTINGS };
  return {
    whoCanChange: (r.who_can_change as ProviderSettings["whoCanChange"]) ?? "anyone",
    lateChangePolicy: (r.late_change_policy as ProviderSettings["lateChangePolicy"]) ?? "direct",
  };
}

export async function setProviderSettings(
  providerId: string,
  patch: Partial<ProviderSettings>,
): Promise<ProviderSettings> {
  const next = { ...(await getProviderSettings(providerId)), ...patch };
  await getSql()`
    INSERT INTO provider_settings (provider_id, who_can_change, late_change_policy)
    VALUES (${providerId}, ${next.whoCanChange}, ${next.lateChangePolicy})
    ON CONFLICT (provider_id)
    DO UPDATE SET who_can_change = EXCLUDED.who_can_change, late_change_policy = EXCLUDED.late_change_policy`;
  return next;
}

// ---------------------------------------------------------------------------
// Appointment change requests (patient's < 24 h manual change, staff sign-off)
// ---------------------------------------------------------------------------

const toChangeRequest = (r: Row): AppointmentChangeRequest => ({
  id: r.id as string,
  organizationId: r.organization_id as string,
  appointmentId: r.appointment_id as string,
  providerId: r.provider_id as string,
  patientId: r.patient_id as string,
  kind: r.kind as ChangeRequestKind,
  newSlotId: (r.new_slot_id as string) ?? undefined,
  reason: (r.reason as string) ?? undefined,
  requestedBy: r.requested_by as string,
  createdAt: r.created_at as string,
  status: r.status as ChangeRequestStatus,
  decidedBy: (r.decided_by as string) ?? undefined,
  decidedAt: (r.decided_at as string) ?? undefined,
});

export async function createChangeRequest(args: {
  organizationId: string;
  appointmentId: string;
  providerId: string;
  patientId: string;
  kind: ChangeRequestKind;
  newSlotId?: string;
  reason?: string;
  requestedBy: string;
}): Promise<AppointmentChangeRequest> {
  const id = uid("chg");
  await getSql()`
    INSERT INTO appointment_change_requests
      (id, organization_id, appointment_id, provider_id, patient_id, kind, new_slot_id, reason, requested_by, created_at, status)
    VALUES (${id}, ${args.organizationId}, ${args.appointmentId}, ${args.providerId}, ${args.patientId}, ${args.kind},
            ${args.newSlotId ?? null}, ${args.reason ?? null}, ${args.requestedBy}, ${new Date().toISOString()}, 'pending')`;
  return (await getChangeRequest(id))!;
}

export async function getChangeRequest(id: string): Promise<AppointmentChangeRequest | undefined> {
  const [r] = (await getSql()`SELECT * FROM appointment_change_requests WHERE id = ${id}`) as unknown as Row[];
  return r ? toChangeRequest(r) : undefined;
}

export async function listChangeRequests(
  opts: {
    organizationId?: string;
    providerId?: string;
    patientId?: string;
    status?: ChangeRequestStatus;
  } = {},
): Promise<AppointmentChangeRequest[]> {
  const sql = getSql();
  const rows = (await sql`
    SELECT * FROM appointment_change_requests
    WHERE (${opts.organizationId ?? null}::text IS NULL OR organization_id = ${opts.organizationId ?? null})
      AND (${opts.providerId ?? null}::text IS NULL OR provider_id = ${opts.providerId ?? null})
      AND (${opts.patientId ?? null}::text IS NULL OR patient_id = ${opts.patientId ?? null})
      AND (${opts.status ?? null}::text IS NULL OR status = ${opts.status ?? null})
    ORDER BY created_at DESC`) as unknown as Row[];
  return rows.map(toChangeRequest);
}

export async function decideChangeRequest(
  id: string,
  args: { status: "approved" | "rejected"; decidedBy: string },
): Promise<void> {
  await getSql()`
    UPDATE appointment_change_requests
    SET status = ${args.status}, decided_by = ${args.decidedBy}, decided_at = ${new Date().toISOString()}
    WHERE id = ${id}`;
}

export async function providerNameTakenInOrg(orgId: string, name: string): Promise<boolean> {
  const t = normName(name);
  const rows = (await getSql()`SELECT name FROM providers WHERE organization_id = ${orgId}`) as unknown as Row[];
  return rows.some((r) => normName(r.name as string) === t);
}

/**
 * Creates a professional in an org: provider + login (if new) + membership + slots.
 * A person already registered (same DNI/email) is reused and just linked to this
 * org with a fresh agenda — their existing PIN stays.
 */
export async function createProfessional(args: {
  organizationId: string;
  name: string;
  email: string;
  dni: string;
  phone?: string;
  specialty: string;
  roomLabel: string;
  pinHash?: string;
  pinSalt?: string;
  canAdmin?: boolean;
}): Promise<{ provider: Provider; userId: string; reusedUser: boolean }> {
  const sql = getSql();
  const providerId = uid("prov");
  const existingUser = (await getUserByDni(args.dni)) ?? (await getUserByEmail(args.email));
  const userId = existingUser?.id ?? uid("u");
  const reusedUser = Boolean(existingUser);

  if (existingUser) {
    const [mem] = (await sql`
      SELECT provider_id FROM memberships
      WHERE user_id = ${userId} AND organization_id = ${args.organizationId} AND role = 'medico'`) as unknown as Row[];
    if (mem?.provider_id) {
      return { provider: (await getProvider(mem.provider_id as string))!, userId, reusedUser: true };
    }
  }

  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO providers (id, organization_id, name, specialty, room_label, default_fee)
      VALUES (${providerId}, ${args.organizationId}, ${args.name.trim()}, ${args.specialty.trim()}, ${args.roomLabel.trim()}, 0)`;

    const slotRows = generateSlotRows(providerId).map((s) => ({
      id: s.id, organization_id: args.organizationId, provider_id: s.providerId,
      start: s.start, duration_minutes: 30, taken: 0,
    }));
    await tx`INSERT INTO slots ${tx(slotRows)}`;

    if (!existingUser) {
      await tx`
        INSERT INTO users (id, name, email, dni, phone, role, pin_hash, pin_salt)
        VALUES (${userId}, ${args.name.trim()}, ${normEmail(args.email)}, ${(args.dni ?? "").trim()},
                ${(args.phone ?? "").trim()}, 'medico', ${args.pinHash ?? ""}, ${args.pinSalt ?? ""})`;
    }
    await tx`
      INSERT INTO memberships (user_id, organization_id, role, provider_id, can_admin)
      VALUES (${userId}, ${args.organizationId}, 'medico', ${providerId}, ${args.canAdmin ? 1 : 0})
      ON CONFLICT (user_id, organization_id)
      DO UPDATE SET role = 'medico', provider_id = EXCLUDED.provider_id, can_admin = EXCLUDED.can_admin`;
  });

  return { provider: (await getProvider(providerId))!, userId, reusedUser };
}

// ---------------------------------------------------------------------------
// Patients (global ficha)
// ---------------------------------------------------------------------------

async function medsFor(patientId: string): Promise<Medication[]> {
  const rows = (await getSql()`SELECT * FROM medications WHERE patient_id = ${patientId} ORDER BY name`) as unknown as Row[];
  return rows.map(toMedication);
}

export async function getPatient(id: string): Promise<Patient | undefined> {
  const [r] = (await getSql()`SELECT * FROM patients WHERE id = ${id}`) as unknown as Row[];
  return r ? toPatient(r, await medsFor(id)) : undefined;
}

export async function getPatientByDni(dni: string): Promise<Patient | undefined> {
  const bare = dni.replace(/\D/g, "");
  const [r] = (await getSql()`
    SELECT * FROM patients WHERE replace(replace(dni, '.', ''), ' ', '') = ${bare}`) as unknown as Row[];
  return r ? toPatient(r, await medsFor(r.id as string)) : undefined;
}

export interface NewPatientInput {
  fullName: string;
  dni: string;
  dateOfBirth: string;
  coverage: string;
  phone?: string;
  email?: string;
  notes?: string;
}

export async function createPatient(input: NewPatientInput): Promise<Patient> {
  const id = uid("pat");
  await getSql()`
    INSERT INTO patients (id, full_name, dni, date_of_birth, phone, email, coverage, allergies, active_conditions, notes)
    VALUES (${id}, ${input.fullName.trim()}, ${input.dni.trim()}, ${input.dateOfBirth.trim()},
            ${input.phone?.trim() ?? ""}, ${input.email?.trim() ?? ""}, ${input.coverage.trim()}, '[]', '[]', ${input.notes?.trim() ?? null})`;
  return (await getPatient(id))!;
}

export interface PatientPatch {
  fullName?: string;
  dni?: string;
  dateOfBirth?: string;
  phone?: string;
  email?: string;
  coverage?: string;
  notes?: string | null;
  allergies?: string[];
  activeConditions?: string[];
}

/** Manual edit of a patient's ficha (staff). Only the provided fields change. */
export async function updatePatient(id: string, patch: PatientPatch): Promise<Patient | undefined> {
  const sql = getSql();
  const set: Record<string, unknown> = {};
  const cols: Record<string, string> = {
    fullName: "full_name",
    dni: "dni",
    dateOfBirth: "date_of_birth",
    phone: "phone",
    email: "email",
    coverage: "coverage",
  };
  for (const [key, col] of Object.entries(cols)) {
    const v = (patch as Record<string, unknown>)[key];
    if (typeof v === "string") set[col] = v.trim();
  }
  if (patch.notes !== undefined) set.notes = patch.notes === null ? null : patch.notes.trim() || null;
  if (patch.allergies !== undefined) {
    set.allergies = JSON.stringify(patch.allergies.map((s) => s.trim()).filter(Boolean));
  }
  if (patch.activeConditions !== undefined) {
    set.active_conditions = JSON.stringify(patch.activeConditions.map((s) => s.trim()).filter(Boolean));
  }
  if (Object.keys(set).length > 0) {
    await sql`UPDATE patients SET ${sql(set)} WHERE id = ${id}`;
  }
  return getPatient(id);
}

// ---------------------------------------------------------------------------
// Medications
// ---------------------------------------------------------------------------

export type MedicationRow = Medication & { id: string };

export async function listMedications(patientId: string): Promise<MedicationRow[]> {
  const rows = (await getSql()`SELECT * FROM medications WHERE patient_id = ${patientId} ORDER BY name`) as unknown as Row[];
  return rows.map((r) => ({ id: r.id as string, ...toMedication(r) }));
}

export async function getMedication(
  id: string,
): Promise<(MedicationRow & { patientId: string }) | undefined> {
  const [r] = (await getSql()`SELECT * FROM medications WHERE id = ${id}`) as unknown as Row[];
  return r ? { id: r.id as string, patientId: r.patient_id as string, ...toMedication(r) } : undefined;
}

export async function addMedication(args: {
  patientId: string;
  name: string;
  dose: string;
  lastPrescribed?: string;
  chronic?: boolean;
}): Promise<MedicationRow> {
  const id = uid("med");
  await getSql()`
    INSERT INTO medications (id, patient_id, name, dose, last_prescribed, chronic)
    VALUES (${id}, ${args.patientId}, ${args.name.trim()}, ${args.dose.trim()},
            ${args.lastPrescribed?.trim() || DEMO_TODAY}, ${args.chronic ? 1 : 0})`;
  return (await getMedication(id))!;
}

export async function updateMedication(
  id: string,
  patch: { name?: string; dose?: string; lastPrescribed?: string; chronic?: boolean },
): Promise<void> {
  const sql = getSql();
  const set: Record<string, unknown> = {};
  if (patch.name !== undefined) set.name = patch.name.trim();
  if (patch.dose !== undefined) set.dose = patch.dose.trim();
  if (patch.lastPrescribed !== undefined) set.last_prescribed = patch.lastPrescribed.trim();
  if (patch.chronic !== undefined) set.chronic = patch.chronic ? 1 : 0;
  if (Object.keys(set).length === 0) return;
  await sql`UPDATE medications SET ${sql(set)} WHERE id = ${id}`;
}

export async function removeMedication(id: string): Promise<void> {
  await getSql()`DELETE FROM medications WHERE id = ${id}`;
}

/**
 * Patients of an organization. With no `query` it returns everyone (ordered by
 * name); with a query it filters by name, DNI, email, phone or id — digits-only
 * on the query also match digits-only DNI / phone.
 */
export async function searchPatients(orgId: string, query: string): Promise<Patient[]> {
  const q = query.trim().toLowerCase();
  const digits = q.replace(/\D/g, "");
  const like = `%${q}%`;
  const digitsLike = `%${digits}%`;
  const rows = (await getSql()`
    SELECT p.* FROM patients p
    JOIN patient_organizations po ON po.patient_id = p.id
    WHERE po.organization_id = ${orgId}
      AND ( ${q} = ''
         OR lower(p.full_name) LIKE ${like}
         OR lower(p.email) LIKE ${like}
         OR lower(p.phone) LIKE ${like}
         OR p.id = ${q}
         OR (${digits} <> '' AND replace(replace(p.dni, '.', ''), ' ', '') LIKE ${digitsLike})
         OR (${digits} <> '' AND replace(replace(replace(p.phone, '+', ''), '-', ''), ' ', '') LIKE ${digitsLike}) )
    ORDER BY p.full_name`) as unknown as Row[];
  return Promise.all(rows.map(async (r) => toPatient(r, await medsFor(r.id as string))));
}

export async function patientInOrg(patientId: string, orgId: string): Promise<boolean> {
  const [r] = (await getSql()`
    SELECT 1 FROM patient_organizations WHERE patient_id = ${patientId} AND organization_id = ${orgId}`) as unknown as Row[];
  return Boolean(r);
}

// ---------------------------------------------------------------------------
// Appointments
// ---------------------------------------------------------------------------

export async function getAppointment(id: string): Promise<Appointment | undefined> {
  const [r] = (await getSql()`SELECT * FROM appointments WHERE id = ${id}`) as unknown as Row[];
  return r ? toAppointment(r) : undefined;
}

export async function getAppointmentsForPatient(
  patientId: string,
  orgIds?: string[],
): Promise<Appointment[]> {
  const rows = (await getSql()`SELECT * FROM appointments WHERE patient_id = ${patientId} ORDER BY start`) as unknown as Row[];
  const list = rows.map(toAppointment);
  return orgIds ? list.filter((a) => orgIds.includes(a.organizationId)) : list;
}

export async function getUpcomingAppointments(
  patientId: string,
  orgIds?: string[],
): Promise<Appointment[]> {
  return (await getAppointmentsForPatient(patientId, orgIds)).filter(
    (a) => a.status === "scheduled" && a.start >= TODAY,
  );
}

/** Agenda view for an org: scheduled + in-progress, optional provider/date filter. */
export async function listAppointments(
  orgId: string,
  opts: { providerId?: string; date?: string } = {},
): Promise<Appointment[]> {
  const rows = (await getSql()`
    SELECT * FROM appointments
    WHERE organization_id = ${orgId}
      AND status IN ('scheduled', 'in-progress')
      AND (${opts.providerId ?? null}::text IS NULL OR provider_id = ${opts.providerId ?? null})
      AND (${opts.date ?? null}::text IS NULL OR substr(start, 1, 10) = ${opts.date ?? null})
    ORDER BY start`) as unknown as Row[];
  return rows.map(toAppointment);
}

export async function inProgressAppointment(
  providerId: string,
  date: string,
): Promise<Appointment | undefined> {
  const [r] = (await getSql()`
    SELECT * FROM appointments
    WHERE provider_id = ${providerId} AND substr(start, 1, 10) = ${date} AND status = 'in-progress' LIMIT 1`) as unknown as Row[];
  return r ? toAppointment(r) : undefined;
}

export async function nextScheduledAppointment(
  providerId: string,
  date: string,
): Promise<Appointment | undefined> {
  const [r] = (await getSql()`
    SELECT * FROM appointments
    WHERE provider_id = ${providerId} AND substr(start, 1, 10) = ${date} AND status = 'scheduled'
    ORDER BY start LIMIT 1`) as unknown as Row[];
  return r ? toAppointment(r) : undefined;
}

export async function providerAppointments(providerId: string): Promise<Appointment[]> {
  const rows = (await getSql()`SELECT * FROM appointments WHERE provider_id = ${providerId} ORDER BY start`) as unknown as Row[];
  return rows.map(toAppointment);
}

// ---------------------------------------------------------------------------
// Slots
// ---------------------------------------------------------------------------

export async function listOpenSlots(
  orgId: string,
  opts: { providerId?: string; date?: string } = {},
): Promise<Slot[]> {
  // Excluye slots de profesionales dados de baja: no se ofrecen turnos nuevos
  // con ellos, aunque sus turnos ya tomados sigan intactos en `appointments`.
  const rows = (await getSql()`
    SELECT s.* FROM slots s
    JOIN providers p ON p.id = s.provider_id
    WHERE s.organization_id = ${orgId} AND s.taken = 0 AND p.active = true
      AND (${opts.providerId ?? null}::text IS NULL OR s.provider_id = ${opts.providerId ?? null})
      AND (${opts.date ?? null}::text IS NULL OR substr(s.start, 1, 10) = ${opts.date ?? null})
    ORDER BY s.start`) as unknown as Row[];
  return rows.map(toSlot);
}

export async function getSlot(id: string): Promise<Slot | undefined> {
  const [r] = (await getSql()`SELECT * FROM slots WHERE id = ${id}`) as unknown as Row[];
  return r ? toSlot(r) : undefined;
}

export async function freeSlotCount(providerId: string, date: string): Promise<number> {
  const [r] = (await getSql()`
    SELECT count(*)::int AS n FROM slots
    WHERE provider_id = ${providerId} AND taken = 0 AND substr(start, 1, 10) = ${date}`) as unknown as Row[];
  return Number(r?.n ?? 0);
}

// ---------------------------------------------------------------------------
// Invoices / labs
// ---------------------------------------------------------------------------

export async function getInvoicesForPatient(patientId: string, orgId?: string): Promise<Invoice[]> {
  const sql = getSql();
  const rows = orgId
    ? ((await sql`SELECT * FROM invoices WHERE patient_id = ${patientId} AND organization_id = ${orgId} ORDER BY date`) as unknown as Row[])
    : ((await sql`SELECT * FROM invoices WHERE patient_id = ${patientId} ORDER BY date`) as unknown as Row[]);
  return rows.map(toInvoice);
}

export async function getInvoice(id: string): Promise<Invoice | undefined> {
  const [r] = (await getSql()`SELECT * FROM invoices WHERE id = ${id}`) as unknown as Row[];
  return r ? toInvoice(r) : undefined;
}

export async function getLabResultsForPatient(patientId: string, orgId?: string): Promise<LabResult[]> {
  const sql = getSql();
  const rows = orgId
    ? ((await sql`SELECT * FROM lab_results WHERE patient_id = ${patientId} AND organization_id = ${orgId} ORDER BY date DESC`) as unknown as Row[])
    : ((await sql`SELECT * FROM lab_results WHERE patient_id = ${patientId} ORDER BY date DESC`) as unknown as Row[]);
  return rows.map(toLab);
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

export async function bookSlot(args: {
  organizationId: string;
  patientId: string;
  slotId: string;
  reason: string;
  createdVia?: Appointment["createdVia"];
}): Promise<Appointment> {
  const sql = getSql();
  const id = uid("apt");
  await sql.begin(async (tx) => {
    const [slot] = (await tx`SELECT * FROM slots WHERE id = ${args.slotId} FOR UPDATE`) as unknown as Row[];
    if (!slot) throw new Error(`El horario ${args.slotId} no existe.`);
    if (Boolean(slot.taken)) throw new Error(`El horario ${args.slotId} ya está ocupado.`);
    await tx`UPDATE slots SET taken = 1 WHERE id = ${args.slotId}`;
    await tx`
      INSERT INTO appointments (id, organization_id, patient_id, provider_id, start, duration_minutes, reason, status, created_via)
      VALUES (${id}, ${args.organizationId}, ${args.patientId}, ${slot.provider_id as string}, ${slot.start as string},
              ${Number(slot.duration_minutes)}, ${args.reason}, 'scheduled', ${args.createdVia ?? "agent"})`;
  });
  return (await getAppointment(id))!;
}

export async function cancelAppointmentById(id: string): Promise<Appointment> {
  const sql = getSql();
  const apt = await getAppointment(id);
  if (!apt) throw new Error(`El turno ${id} no existe.`);
  await sql`UPDATE appointments SET status = 'cancelled' WHERE id = ${id}`;
  await sql`UPDATE slots SET taken = 0 WHERE provider_id = ${apt.providerId} AND start = ${apt.start}`;
  return (await getAppointment(id))!;
}

export async function createPrescriptionRequest(args: {
  organizationId: string;
  patientId: string;
  medication: string;
  decision: "approved" | "denied";
  decidedBy?: string;
  note?: string;
}): Promise<PrescriptionRequest> {
  const id = uid("rx");
  const requestedAt = new Date().toISOString();
  const status = args.decision === "approved" ? "approved" : "denied";
  await getSql()`
    INSERT INTO prescription_requests (id, organization_id, patient_id, medication, requested_at, status, decided_by, note)
    VALUES (${id}, ${args.organizationId}, ${args.patientId}, ${args.medication}, ${requestedAt}, ${status}, ${args.decidedBy ?? null}, ${args.note ?? null})`;
  return {
    id,
    patientId: args.patientId,
    medication: args.medication,
    requestedAt,
    status,
    decidedBy: args.decidedBy,
    note: args.note,
  };
}

export async function recordPatientMessage(
  orgId: string,
  patientId: string,
  body: string,
): Promise<PatientMessage> {
  const id = uid("msg");
  const sentAt = new Date().toISOString();
  await getSql()`
    INSERT INTO patient_messages (id, organization_id, patient_id, body, sent_at)
    VALUES (${id}, ${orgId}, ${patientId}, ${body}, ${sentAt})`;
  return { id, patientId, body, sentAt };
}

export async function refundInvoice(id: string): Promise<Invoice> {
  const inv = await getInvoice(id);
  if (!inv) throw new Error(`La factura ${id} no existe.`);
  await getSql()`UPDATE invoices SET status = 'refunded' WHERE id = ${id}`;
  return (await getInvoice(id))!;
}

// ---------------------------------------------------------------------------
// Pricing
// ---------------------------------------------------------------------------

export async function listProviderPrices(providerId: string): Promise<PriceItem[]> {
  const rows = (await getSql()`
    SELECT id, label, amount FROM provider_prices WHERE provider_id = ${providerId} ORDER BY label`) as unknown as Row[];
  return rows.map((r) => ({ id: r.id as string, label: r.label as string, amount: Number(r.amount) }));
}

export async function setProviderFee(providerId: string, amount: number): Promise<void> {
  await getSql()`UPDATE providers SET default_fee = ${Math.round(amount)} WHERE id = ${providerId}`;
}

export async function addProviderPrice(
  orgId: string,
  providerId: string,
  label: string,
  amount: number,
): Promise<PriceItem> {
  const id = uid("price");
  await getSql()`
    INSERT INTO provider_prices (id, organization_id, provider_id, label, amount)
    VALUES (${id}, ${orgId}, ${providerId}, ${label.trim()}, ${Math.round(amount)})`;
  return { id, label: label.trim(), amount: Math.round(amount) };
}

export async function priceForReason(providerId: string, reason: string): Promise<number> {
  const r = reason.trim().toLowerCase();
  const prices = await listProviderPrices(providerId);
  const match = prices.find(
    (p) => r.includes(p.label.toLowerCase()) || p.label.toLowerCase().includes(r),
  );
  return match ? match.amount : (await getProvider(providerId))?.defaultFee ?? 0;
}

export async function setAppointmentStatus(id: string, status: Appointment["status"]): Promise<void> {
  await getSql()`UPDATE appointments SET status = ${status} WHERE id = ${id}`;
}

export async function setAppointmentPrice(id: string, price: number): Promise<void> {
  await getSql()`UPDATE appointments SET price = ${Math.round(price)} WHERE id = ${id}`;
}

// ---------------------------------------------------------------------------
// Daily reports (per org)
// ---------------------------------------------------------------------------

export interface ProviderDayReport {
  providerId: string;
  providerName: string;
  specialty: string;
  attended: { patient: string; reason: string; time: string; price: number }[];
  attendedCount: number;
  cancelledCount: number;
  stillScheduled: number;
  revenue: number;
}

export interface DayReport {
  date: string;
  clinicRevenue: number;
  totalAttended: number;
  providers: ProviderDayReport[];
}

export async function buildDayReport(
  orgId: string,
  date: string,
  providerId?: string,
): Promise<DayReport> {
  const providers = providerId
    ? ([await getProvider(providerId)].filter(Boolean) as Provider[])
    : await listProviders(orgId);
  const rows = (await getSql()`
    SELECT * FROM appointments WHERE organization_id = ${orgId} AND substr(start, 1, 10) = ${date}`) as unknown as Row[];
  const appts = rows.map(toAppointment);

  const perProvider: ProviderDayReport[] = await Promise.all(
    providers.map(async (prov) => {
      const mine = appts.filter((a) => a.providerId === prov.id);
      const attended = mine.filter((a) => a.status === "completed").sort((a, b) => a.start.localeCompare(b.start));
      const attendedRows = await Promise.all(
        attended.map(async (a) => ({
          patient: (await getPatient(a.patientId))?.fullName ?? a.patientId,
          reason: a.reason,
          time: a.start.slice(11, 16),
          price: a.price,
        })),
      );
      return {
        providerId: prov.id,
        providerName: prov.name,
        specialty: prov.specialty,
        attended: attendedRows,
        attendedCount: attended.length,
        cancelledCount: mine.filter((a) => a.status === "cancelled").length,
        stillScheduled: mine.filter((a) => a.status === "scheduled").length,
        revenue: attended.reduce((s, a) => s + a.price, 0),
      };
    }),
  );

  return {
    date,
    clinicRevenue: perProvider.reduce((s, p) => s + p.revenue, 0),
    totalAttended: perProvider.reduce((s, p) => s + p.attendedCount, 0),
    providers: perProvider,
  };
}

export async function saveDailyReport(
  orgId: string,
  date: string,
  providerId: string,
  generatedBy: string,
  payload: unknown,
): Promise<void> {
  await getSql()`
    INSERT INTO daily_reports (organization_id, date, provider_id, generated_at, generated_by, payload)
    VALUES (${orgId}, ${date}, ${providerId}, ${new Date().toISOString()}, ${generatedBy}, ${JSON.stringify(payload)})
    ON CONFLICT (organization_id, date, provider_id)
    DO UPDATE SET generated_at = EXCLUDED.generated_at, generated_by = EXCLUDED.generated_by, payload = EXCLUDED.payload`;
}

export async function getSavedDailyReport(
  orgId: string,
  date: string,
  providerId: string,
): Promise<{ generatedAt: string; generatedBy?: string; payload: unknown } | undefined> {
  const [r] = (await getSql()`
    SELECT * FROM daily_reports WHERE organization_id = ${orgId} AND date = ${date} AND provider_id = ${providerId}`) as unknown as Row[];
  if (!r) return undefined;
  return {
    generatedAt: r.generated_at as string,
    generatedBy: (r.generated_by as string) ?? undefined,
    payload: JSON.parse(r.payload as string),
  };
}

// ---------------------------------------------------------------------------
// Live agenda
// ---------------------------------------------------------------------------

const hm = (iso: string) => iso.slice(11, 16);
const dayOf = (iso: string) => iso.slice(0, 10);

function minutesBetween(a: string, b: string): number {
  return (Date.parse(b.replace(" ", "T")) - Date.parse(a.replace(" ", "T"))) / 60000;
}
function addMinutes(iso: string, min: number): string {
  const d = new Date(iso.replace(" ", "T"));
  d.setMinutes(d.getMinutes() + Math.round(min));
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:00`;
}

export async function isBirthday(patientId: string, date: string): Promise<boolean> {
  const p = await getPatient(patientId);
  return Boolean(p && p.dateOfBirth.slice(5) === date.slice(5));
}

async function initialClock(providerId: string, date: string): Promise<string> {
  const [r] = (await getSql()`
    SELECT start FROM appointments
    WHERE provider_id = ${providerId} AND substr(start, 1, 10) = ${date} AND status IN ('scheduled', 'in-progress')
    ORDER BY start LIMIT 1`) as unknown as Row[];
  return (r?.start as string) ?? `${date}T09:00:00`;
}

export async function getClinicClock(providerId: string, date: string): Promise<string> {
  const sql = getSql();
  const [r] = (await sql`SELECT clock FROM clinic_state WHERE date = ${date} AND provider_id = ${providerId}`) as unknown as Row[];
  if (r?.clock) return r.clock as string;
  const c = await initialClock(providerId, date);
  const orgId = (await getProvider(providerId))?.organizationId ?? "";
  await sql`
    INSERT INTO clinic_state (organization_id, date, provider_id, clock)
    VALUES (${orgId}, ${date}, ${providerId}, ${c})
    ON CONFLICT (date, provider_id) DO UPDATE SET clock = EXCLUDED.clock, organization_id = EXCLUDED.organization_id`;
  return c;
}

export async function setClinicClock(providerId: string, date: string, iso: string): Promise<void> {
  const orgId = (await getProvider(providerId))?.organizationId ?? "";
  await getSql()`
    INSERT INTO clinic_state (organization_id, date, provider_id, clock)
    VALUES (${orgId}, ${date}, ${providerId}, ${iso})
    ON CONFLICT (date, provider_id) DO UPDATE SET clock = EXCLUDED.clock, organization_id = EXCLUDED.organization_id`;
}

export interface AgendaEntry {
  appointmentId: string;
  patientId: string;
  patientName: string;
  reason: string;
  status: Appointment["status"];
  scheduled: string;
  estimated: string;
  delayMinutes: number;
  isBirthday: boolean;
}

export interface ProviderAgenda {
  providerId: string;
  providerName: string;
  date: string;
  clock: string;
  running: "en horario" | "atrasada" | "adelantada";
  offsetMinutes: number;
  inAttention?: AgendaEntry;
  next?: AgendaEntry;
  upcoming: AgendaEntry[];
  attendedToday: number;
}

export async function providerAgenda(providerId: string, date: string): Promise<ProviderAgenda> {
  const clock = await getClinicClock(providerId, date);
  const rows = (await getSql()`
    SELECT * FROM appointments WHERE provider_id = ${providerId} AND substr(start, 1, 10) = ${date} ORDER BY start`) as unknown as Row[];
  const appts = rows.map(toAppointment);

  const active = appts.find((a) => a.status === "in-progress");
  const pending = appts.filter((a) => a.status === "scheduled");
  const ref = active ?? pending[0];
  const offset = ref ? Math.round(minutesBetween(ref.start, clock)) : 0;
  const late = Math.max(0, offset);

  const entry = async (a: Appointment): Promise<AgendaEntry> => {
    const est = addMinutes(a.start, late);
    return {
      appointmentId: a.id,
      patientId: a.patientId,
      patientName: (await getPatient(a.patientId))?.fullName ?? a.patientId,
      reason: a.reason,
      status: a.status,
      scheduled: hm(a.start),
      estimated: hm(est),
      delayMinutes: Math.round(minutesBetween(a.start, est)),
      isBirthday: await isBirthday(a.patientId, date),
    };
  };

  return {
    providerId,
    providerName: (await getProvider(providerId))?.name ?? providerId,
    date,
    clock: hm(clock),
    running: offset > 5 ? "atrasada" : offset < -5 ? "adelantada" : "en horario",
    offsetMinutes: offset,
    inAttention: active ? await entry(active) : undefined,
    next: pending[0] ? await entry(pending[0]) : undefined,
    upcoming: await Promise.all(pending.slice(1).map(entry)),
    attendedToday: appts.filter((a) => a.status === "completed").length,
  };
}

export async function startAttention(appointmentId: string): Promise<Appointment> {
  const a = await getAppointment(appointmentId);
  if (!a) throw new Error(`El turno ${appointmentId} no existe.`);
  if (a.status !== "scheduled") throw new Error(`El turno está ${a.status}, no se puede iniciar.`);
  const clock = await getClinicClock(a.providerId, dayOf(a.start));
  await getSql()`UPDATE appointments SET status = 'in-progress', actual_start = ${clock} WHERE id = ${appointmentId}`;
  return (await getAppointment(appointmentId))!;
}

export async function finishAttention(
  appointmentId: string,
  actualMinutes?: number,
): Promise<Appointment> {
  const a = await getAppointment(appointmentId);
  if (!a) throw new Error(`El turno ${appointmentId} no existe.`);
  const date = dayOf(a.start);
  const startedAt = a.actualStart ?? (await getClinicClock(a.providerId, date));
  const dur = Math.max(1, Math.round(actualMinutes ?? a.durationMinutes));
  const endAt = addMinutes(startedAt, dur);
  await getSql()`
    UPDATE appointments
    SET status = 'completed', actual_end = ${endAt}, actual_start = COALESCE(actual_start, ${startedAt})
    WHERE id = ${appointmentId}`;
  await setClinicClock(a.providerId, date, endAt);
  return (await getAppointment(appointmentId))!;
}

/** Patient's next scheduled/in-progress appointment across the given orgs. */
export async function patientNextAppointment(
  patientId: string,
  date: string,
  orgIds: string[],
): Promise<Appointment | undefined> {
  const rows = (await getSql()`
    SELECT * FROM appointments
    WHERE patient_id = ${patientId} AND substr(start, 1, 10) = ${date} AND status IN ('scheduled', 'in-progress')
    ORDER BY start`) as unknown as Row[];
  return rows.map(toAppointment).find((a) => orgIds.includes(a.organizationId));
}

export async function replacePatientNotice(
  orgId: string,
  appointmentId: string,
  patientId: string,
  date: string,
  message: string,
): Promise<void> {
  const sql = getSql();
  await sql`UPDATE patient_notices SET resolved = 1 WHERE appointment_id = ${appointmentId} AND resolved = 0`;
  await sql`
    INSERT INTO patient_notices (id, organization_id, appointment_id, patient_id, date, created_at, message, resolved)
    VALUES (${uid("ntc")}, ${orgId}, ${appointmentId}, ${patientId}, ${date}, ${new Date().toISOString()}, ${message}, 0)`;
}

export async function listPatientNotices(
  patientId: string,
  date: string,
): Promise<{ id: string; message: string; createdAt: string }[]> {
  const rows = (await getSql()`
    SELECT id, message, created_at FROM patient_notices
    WHERE patient_id = ${patientId} AND date = ${date} AND resolved = 0 ORDER BY created_at`) as unknown as Row[];
  return rows.map((r) => ({ id: r.id as string, message: r.message as string, createdAt: r.created_at as string }));
}

export async function resolvePatientNotice(id: string): Promise<void> {
  await getSql()`UPDATE patient_notices SET resolved = 1 WHERE id = ${id}`;
}

export async function clearNoticesForAppointment(appointmentId: string): Promise<void> {
  await getSql()`UPDATE patient_notices SET resolved = 1 WHERE appointment_id = ${appointmentId} AND resolved = 0`;
}

export async function earlierOpeningToday(
  providerId: string,
  date: string,
  beforeHm: string,
): Promise<{ slotId: string; time: string } | undefined> {
  const clockHm = hm(await getClinicClock(providerId, date));
  const rows = (await getSql()`
    SELECT id, start FROM slots
    WHERE provider_id = ${providerId} AND taken = 0 AND substr(start, 1, 10) = ${date} ORDER BY start`) as unknown as Row[];
  for (const r of rows) {
    const t = (r.start as string).slice(11, 16);
    if (t >= clockHm && t < beforeHm) return { slotId: r.id as string, time: t };
  }
  return undefined;
}
