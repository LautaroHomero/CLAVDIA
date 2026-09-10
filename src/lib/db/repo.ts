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
import { getDb } from "./connection";
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
  defaultFee: (r.default_fee as number) ?? 0,
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
  durationMinutes: r.duration_minutes as number,
  reason: r.reason as string,
  status: r.status as Appointment["status"],
  price: (r.price as number) ?? 0,
  actualStart: (r.actual_start as string) ?? undefined,
  actualEnd: (r.actual_end as string) ?? undefined,
  createdVia: r.created_via as Appointment["createdVia"],
});

const toSlot = (r: Row): Slot => ({
  id: r.id as string,
  providerId: r.provider_id as string,
  start: r.start as string,
  durationMinutes: r.duration_minutes as number,
  taken: Boolean(r.taken),
});

const toInvoice = (r: Row): Invoice => ({
  id: r.id as string,
  organizationId: r.organization_id as string,
  patientId: r.patient_id as string,
  date: r.date as string,
  concept: r.concept as string,
  amount: r.amount as number,
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

export function listOrganizations(): Organization[] {
  return (getDb().prepare("SELECT * FROM organizations ORDER BY name").all() as Row[]).map(toOrg);
}

export function getOrganization(id: string): Organization | undefined {
  const r = getDb().prepare("SELECT * FROM organizations WHERE id = ?").get(id) as Row | undefined;
  return r ? toOrg(r) : undefined;
}

function normName(s: string): string {
  return s.trim().toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
}

function slugify(s: string): string {
  return normName(s).replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "org";
}

export function createOrganization(input: {
  name: string;
  address?: string;
  city?: string;
  phone?: string;
  hours?: string;
}): Organization {
  const db = getDb();
  let slug = slugify(input.name);
  if (db.prepare("SELECT 1 FROM organizations WHERE slug = ?").get(slug)) slug = `${slug}-${uid("").slice(1, 5)}`;
  const id = uid("org");
  db.prepare(
    "INSERT INTO organizations (id, name, slug, address, city, hours, phone, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    id,
    input.name.trim(),
    slug,
    input.address?.trim() ?? "",
    input.city?.trim() ?? "",
    input.hours?.trim() || "Lunes a viernes de 8 a 18 h",
    input.phone?.trim() ?? "",
    new Date().toISOString(),
  );
  return getOrganization(id)!;
}

export function organizationNameTaken(name: string): boolean {
  const t = normName(name);
  return (getDb().prepare("SELECT name FROM organizations").all() as Row[]).some(
    (r) => normName(r.name as string) === t,
  );
}

// ---------------------------------------------------------------------------
// Users, memberships, auth
// ---------------------------------------------------------------------------

const toUser = (r: Row): User => ({
  id: r.id as string,
  name: r.name as string,
  email: (r.email as string) ?? "",
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

export function membershipsForUser(userId: string): Membership[] {
  return (
    getDb()
      .prepare(
        `SELECT m.organization_id, o.name AS org_name, m.role, m.provider_id, m.can_admin, p.specialty
         FROM memberships m
         JOIN organizations o ON o.id = m.organization_id
         LEFT JOIN providers p ON p.id = m.provider_id
         WHERE m.user_id = ?
         ORDER BY o.name`,
      )
      .all(userId) as Row[]
  ).map((r) => ({
    organizationId: r.organization_id as string,
    organizationName: r.org_name as string,
    role: r.role as StaffRole,
    providerId: (r.provider_id as string) ?? undefined,
    specialty: (r.specialty as string) ?? undefined,
    // secretaría always administers; a médico only if flagged (org founder).
    canAdmin: Boolean(r.can_admin) || (r.role as StaffRole) === "recepcion",
  }));
}

export function patientOrgs(patientId: string): OrgRef[] {
  return (
    getDb()
      .prepare(
        `SELECT o.id, o.name FROM patient_organizations po
         JOIN organizations o ON o.id = po.organization_id
         WHERE po.patient_id = ? ORDER BY o.name`,
      )
      .all(patientId) as Row[]
  ).map((r) => ({ id: r.id as string, name: r.name as string }));
}

export function joinPatientOrg(patientId: string, organizationId: string): void {
  getDb()
    .prepare(
      "INSERT OR IGNORE INTO patient_organizations (patient_id, organization_id, joined_at) VALUES (?, ?, ?)",
    )
    .run(patientId, organizationId, new Date().toISOString());
}

export const normEmail = (s: string): string => s.trim().toLowerCase();

export function getUserByName(name: string): (User & { pinHash: string; pinSalt: string }) | undefined {
  const target = normName(name);
  const r = (getDb().prepare("SELECT * FROM users").all() as Row[]).find(
    (row) => normName(row.name as string) === target,
  );
  if (!r) return undefined;
  return { ...toUser(r), pinHash: r.pin_hash as string, pinSalt: r.pin_salt as string };
}

/** Primary login lookup — email is the identifier for every role. */
export function getUserByEmail(email: string): (User & { pinHash: string; pinSalt: string }) | undefined {
  const target = normEmail(email);
  if (!target) return undefined;
  const r = (getDb().prepare("SELECT * FROM users").all() as Row[]).find(
    (row) => normEmail((row.email as string) ?? "") === target,
  );
  if (!r) return undefined;
  return { ...toUser(r), pinHash: r.pin_hash as string, pinSalt: r.pin_salt as string };
}

export function getUser(id: string): User | undefined {
  const r = getDb().prepare("SELECT * FROM users WHERE id = ?").get(id) as Row | undefined;
  return r ? toUser(r) : undefined;
}

export function userNameTaken(name: string): boolean {
  const t = normName(name);
  return (getDb().prepare("SELECT name FROM users").all() as Row[]).some(
    (r) => normName(r.name as string) === t,
  );
}

export function userEmailTaken(email: string): boolean {
  const t = normEmail(email);
  return (getDb().prepare("SELECT email FROM users").all() as Row[]).some(
    (r) => normEmail((r.email as string) ?? "") === t,
  );
}

export function createUser(args: {
  name: string;
  email: string;
  role: Role;
  pinHash: string;
  pinSalt: string;
  patientId?: string;
}): User {
  const id = uid("u");
  const email = normEmail(args.email);
  getDb()
    .prepare(
      "INSERT INTO users (id, name, email, role, pin_hash, pin_salt, patient_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .run(id, args.name.trim(), email, args.role, args.pinHash, args.pinSalt, args.patientId ?? null);
  return { id, name: args.name.trim(), email, role: args.role, patientId: args.patientId };
}

export function addMembership(args: {
  userId: string;
  organizationId: string;
  role: StaffRole;
  providerId?: string;
  canAdmin?: boolean;
}): void {
  getDb()
    .prepare(
      "INSERT OR REPLACE INTO memberships (user_id, organization_id, role, provider_id, can_admin) VALUES (?, ?, ?, ?, ?)",
    )
    .run(args.userId, args.organizationId, args.role, args.providerId ?? null, args.canAdmin ? 1 : 0);
}

// ---------------------------------------------------------------------------
// Providers (per org)
// ---------------------------------------------------------------------------

export function listProviders(orgId: string): Provider[] {
  return (
    getDb().prepare("SELECT * FROM providers WHERE organization_id = ? ORDER BY name").all(orgId) as Row[]
  ).map(toProvider);
}

export function getProvider(id: string): Provider | undefined {
  const r = getDb().prepare("SELECT * FROM providers WHERE id = ?").get(id) as Row | undefined;
  return r ? toProvider(r) : undefined;
}

// ---------------------------------------------------------------------------
// Provider settings — per-professional policy for MANUAL appointment changes
// ---------------------------------------------------------------------------

const DEFAULT_PROVIDER_SETTINGS: ProviderSettings = {
  whoCanChange: "anyone",
  lateChangePolicy: "direct",
};

export function getProviderSettings(providerId: string): ProviderSettings {
  const r = getDb()
    .prepare("SELECT who_can_change, late_change_policy FROM provider_settings WHERE provider_id = ?")
    .get(providerId) as Row | undefined;
  if (!r) return { ...DEFAULT_PROVIDER_SETTINGS };
  return {
    whoCanChange: (r.who_can_change as ProviderSettings["whoCanChange"]) ?? "anyone",
    lateChangePolicy: (r.late_change_policy as ProviderSettings["lateChangePolicy"]) ?? "direct",
  };
}

export function setProviderSettings(providerId: string, patch: Partial<ProviderSettings>): ProviderSettings {
  const next = { ...getProviderSettings(providerId), ...patch };
  getDb()
    .prepare(
      `INSERT INTO provider_settings (provider_id, who_can_change, late_change_policy)
       VALUES (@id, @who, @late)
       ON CONFLICT(provider_id) DO UPDATE SET who_can_change = @who, late_change_policy = @late`,
    )
    .run({ id: providerId, who: next.whoCanChange, late: next.lateChangePolicy });
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

export function createChangeRequest(args: {
  organizationId: string;
  appointmentId: string;
  providerId: string;
  patientId: string;
  kind: ChangeRequestKind;
  newSlotId?: string;
  reason?: string;
  requestedBy: string;
}): AppointmentChangeRequest {
  const id = uid("chg");
  getDb()
    .prepare(
      `INSERT INTO appointment_change_requests
        (id, organization_id, appointment_id, provider_id, patient_id, kind, new_slot_id, reason, requested_by, created_at, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
    )
    .run(
      id,
      args.organizationId,
      args.appointmentId,
      args.providerId,
      args.patientId,
      args.kind,
      args.newSlotId ?? null,
      args.reason ?? null,
      args.requestedBy,
      new Date().toISOString(),
    );
  return getChangeRequest(id)!;
}

export function getChangeRequest(id: string): AppointmentChangeRequest | undefined {
  const r = getDb().prepare("SELECT * FROM appointment_change_requests WHERE id = ?").get(id) as Row | undefined;
  return r ? toChangeRequest(r) : undefined;
}

export function listChangeRequests(opts: {
  organizationId?: string;
  providerId?: string;
  patientId?: string;
  status?: ChangeRequestStatus;
} = {}): AppointmentChangeRequest[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM appointment_change_requests
       WHERE (@org IS NULL OR organization_id = @org)
         AND (@provider IS NULL OR provider_id = @provider)
         AND (@patient IS NULL OR patient_id = @patient)
         AND (@status IS NULL OR status = @status)
       ORDER BY created_at DESC`,
    )
    .all({
      org: opts.organizationId ?? null,
      provider: opts.providerId ?? null,
      patient: opts.patientId ?? null,
      status: opts.status ?? null,
    }) as Row[];
  return rows.map(toChangeRequest);
}

export function decideChangeRequest(id: string, args: { status: "approved" | "rejected"; decidedBy: string }): void {
  getDb()
    .prepare(
      "UPDATE appointment_change_requests SET status = ?, decided_by = ?, decided_at = ? WHERE id = ?",
    )
    .run(args.status, args.decidedBy, new Date().toISOString(), id);
}

export function providerNameTakenInOrg(orgId: string, name: string): boolean {
  const t = normName(name);
  return (
    getDb().prepare("SELECT name FROM providers WHERE organization_id = ?").all(orgId) as Row[]
  ).some((r) => normName(r.name as string) === t);
}

/**
 * Creates a professional in an org: provider + login (if new) + membership + slots.
 * A person already registered (same email) is reused and just linked to this org
 * with a fresh agenda — their existing PIN stays.
 */
export function createProfessional(args: {
  organizationId: string;
  name: string;
  email: string;
  specialty: string;
  roomLabel: string;
  pinHash: string;
  pinSalt: string;
  canAdmin?: boolean;
}): { provider: Provider; userId: string; reusedUser: boolean } {
  const db = getDb();
  const providerId = uid("prov");
  const existingUser = getUserByEmail(args.email);
  const userId = existingUser?.id ?? uid("u");
  const reusedUser = Boolean(existingUser);

  const tx = db.transaction(() => {
    db.prepare(
      "INSERT INTO providers (id, organization_id, name, specialty, room_label, default_fee) VALUES (?, ?, ?, ?, ?, 0)",
    ).run(providerId, args.organizationId, args.name.trim(), args.specialty.trim(), args.roomLabel.trim());

    const slot = db.prepare(
      "INSERT INTO slots (id, organization_id, provider_id, start, duration_minutes, taken) VALUES (?, ?, ?, ?, 30, 0)",
    );
    for (const s of generateSlotRows(providerId)) slot.run(s.id, args.organizationId, s.providerId, s.start);

    if (!existingUser) {
      db.prepare(
        "INSERT INTO users (id, name, email, role, pin_hash, pin_salt) VALUES (?, ?, ?, 'medico', ?, ?)",
      ).run(userId, args.name.trim(), normEmail(args.email), args.pinHash, args.pinSalt);
    }
    db.prepare(
      "INSERT OR REPLACE INTO memberships (user_id, organization_id, role, provider_id, can_admin) VALUES (?, ?, 'medico', ?, ?)",
    ).run(userId, args.organizationId, providerId, args.canAdmin ? 1 : 0);
  });
  tx();
  return { provider: getProvider(providerId)!, userId, reusedUser };
}

// ---------------------------------------------------------------------------
// Patients (global ficha)
// ---------------------------------------------------------------------------

function medsFor(patientId: string): Medication[] {
  return (
    getDb().prepare("SELECT * FROM medications WHERE patient_id = ? ORDER BY name").all(patientId) as Row[]
  ).map(toMedication);
}

export function getPatient(id: string): Patient | undefined {
  const r = getDb().prepare("SELECT * FROM patients WHERE id = ?").get(id) as Row | undefined;
  return r ? toPatient(r, medsFor(id)) : undefined;
}

export function getPatientByDni(dni: string): Patient | undefined {
  const bare = dni.replace(/\D/g, "");
  const r = getDb()
    .prepare("SELECT * FROM patients WHERE replace(replace(dni,'.',''),' ','') = ?")
    .get(bare) as Row | undefined;
  return r ? toPatient(r, medsFor(r.id as string)) : undefined;
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

export function createPatient(input: NewPatientInput): Patient {
  const id = uid("pat");
  getDb()
    .prepare(
      `INSERT INTO patients (id, full_name, dni, date_of_birth, phone, email, coverage, allergies, active_conditions, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, '[]', '[]', ?)`,
    )
    .run(
      id,
      input.fullName.trim(),
      input.dni.trim(),
      input.dateOfBirth.trim(),
      input.phone?.trim() ?? "",
      input.email?.trim() ?? "",
      input.coverage.trim(),
      input.notes?.trim() ?? null,
    );
  return getPatient(id)!;
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
export function updatePatient(id: string, patch: PatientPatch): Patient | undefined {
  const cols: Record<string, string> = {
    fullName: "full_name",
    dni: "dni",
    dateOfBirth: "date_of_birth",
    phone: "phone",
    email: "email",
    coverage: "coverage",
  };
  const sets: string[] = [];
  const vals: unknown[] = [];
  for (const [key, col] of Object.entries(cols)) {
    const v = (patch as Record<string, unknown>)[key];
    if (typeof v === "string") {
      sets.push(`${col} = ?`);
      vals.push(v.trim());
    }
  }
  if (patch.notes !== undefined) {
    sets.push("notes = ?");
    vals.push(patch.notes === null ? null : patch.notes.trim() || null);
  }
  if (patch.allergies !== undefined) {
    sets.push("allergies = ?");
    vals.push(JSON.stringify(patch.allergies.map((s) => s.trim()).filter(Boolean)));
  }
  if (patch.activeConditions !== undefined) {
    sets.push("active_conditions = ?");
    vals.push(JSON.stringify(patch.activeConditions.map((s) => s.trim()).filter(Boolean)));
  }
  if (sets.length > 0) {
    getDb().prepare(`UPDATE patients SET ${sets.join(", ")} WHERE id = ?`).run(...vals, id);
  }
  return getPatient(id);
}

// ---------------------------------------------------------------------------
// Medications
// ---------------------------------------------------------------------------

export type MedicationRow = Medication & { id: string };

export function listMedications(patientId: string): MedicationRow[] {
  return (
    getDb().prepare("SELECT * FROM medications WHERE patient_id = ? ORDER BY name").all(patientId) as Row[]
  ).map((r) => ({ id: r.id as string, ...toMedication(r) }));
}

export function getMedication(id: string): (MedicationRow & { patientId: string }) | undefined {
  const r = getDb().prepare("SELECT * FROM medications WHERE id = ?").get(id) as Row | undefined;
  return r ? { id: r.id as string, patientId: r.patient_id as string, ...toMedication(r) } : undefined;
}

export function addMedication(args: {
  patientId: string;
  name: string;
  dose: string;
  lastPrescribed?: string;
  chronic?: boolean;
}): MedicationRow {
  const id = uid("med");
  getDb()
    .prepare(
      "INSERT INTO medications (id, patient_id, name, dose, last_prescribed, chronic) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(
      id,
      args.patientId,
      args.name.trim(),
      args.dose.trim(),
      args.lastPrescribed?.trim() || DEMO_TODAY,
      args.chronic ? 1 : 0,
    );
  return getMedication(id)!;
}

export function updateMedication(
  id: string,
  patch: { name?: string; dose?: string; lastPrescribed?: string; chronic?: boolean },
): void {
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (patch.name !== undefined) {
    sets.push("name = ?");
    vals.push(patch.name.trim());
  }
  if (patch.dose !== undefined) {
    sets.push("dose = ?");
    vals.push(patch.dose.trim());
  }
  if (patch.lastPrescribed !== undefined) {
    sets.push("last_prescribed = ?");
    vals.push(patch.lastPrescribed.trim());
  }
  if (patch.chronic !== undefined) {
    sets.push("chronic = ?");
    vals.push(patch.chronic ? 1 : 0);
  }
  if (sets.length === 0) return;
  getDb().prepare(`UPDATE medications SET ${sets.join(", ")} WHERE id = ?`).run(...vals, id);
}

export function removeMedication(id: string): void {
  getDb().prepare("DELETE FROM medications WHERE id = ?").run(id);
}

/** Search patients that belong to a given org. */
/**
 * Patients of an organization. With no `query` it returns everyone (ordered by
 * name); with a query it filters by name, DNI, email, phone or id — digits-only
 * on the query also match digits-only DNI / phone.
 */
export function searchPatients(orgId: string, query: string): Patient[] {
  const q = query.trim().toLowerCase();
  const digits = q.replace(/\D/g, "");
  const rows = getDb()
    .prepare(
      `SELECT p.* FROM patients p
       JOIN patient_organizations po ON po.patient_id = p.id
       WHERE po.organization_id = @org
         AND ( @q = ''
            OR lower(p.full_name) LIKE @like
            OR lower(p.email) LIKE @like
            OR lower(p.phone) LIKE @like
            OR p.id = @exact
            OR (@digits <> '' AND replace(replace(p.dni, '.', ''), ' ', '') LIKE @digitsLike)
            OR (@digits <> '' AND replace(replace(replace(p.phone, '+', ''), '-', ''), ' ', '') LIKE @digitsLike) )
       ORDER BY p.full_name`,
    )
    .all({
      org: orgId,
      q,
      like: `%${q}%`,
      digits,
      digitsLike: `%${digits}%`,
      exact: q,
    }) as Row[];
  return rows.map((r) => toPatient(r, medsFor(r.id as string)));
}

export function patientInOrg(patientId: string, orgId: string): boolean {
  return Boolean(
    getDb()
      .prepare("SELECT 1 FROM patient_organizations WHERE patient_id = ? AND organization_id = ?")
      .get(patientId, orgId),
  );
}

// ---------------------------------------------------------------------------
// Appointments
// ---------------------------------------------------------------------------

export function getAppointment(id: string): Appointment | undefined {
  const r = getDb().prepare("SELECT * FROM appointments WHERE id = ?").get(id) as Row | undefined;
  return r ? toAppointment(r) : undefined;
}

export function getAppointmentsForPatient(patientId: string, orgIds?: string[]): Appointment[] {
  const rows = getDb()
    .prepare("SELECT * FROM appointments WHERE patient_id = ? ORDER BY start")
    .all(patientId) as Row[];
  const list = rows.map(toAppointment);
  return orgIds ? list.filter((a) => orgIds.includes(a.organizationId)) : list;
}

export function getUpcomingAppointments(patientId: string, orgIds?: string[]): Appointment[] {
  return getAppointmentsForPatient(patientId, orgIds).filter(
    (a) => a.status === "scheduled" && a.start >= TODAY,
  );
}

/** Agenda view for an org: scheduled + in-progress, optional provider/date filter. */
export function listAppointments(
  orgId: string,
  opts: { providerId?: string; date?: string } = {},
): Appointment[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM appointments
       WHERE organization_id = @org
         AND status IN ('scheduled', 'in-progress')
         AND (@providerId IS NULL OR provider_id = @providerId)
         AND (@date IS NULL OR substr(start, 1, 10) = @date)
       ORDER BY start`,
    )
    .all({ org: orgId, providerId: opts.providerId ?? null, date: opts.date ?? null }) as Row[];
  return rows.map(toAppointment);
}

export function inProgressAppointment(providerId: string, date: string): Appointment | undefined {
  const r = getDb()
    .prepare(
      "SELECT * FROM appointments WHERE provider_id = ? AND substr(start,1,10) = ? AND status = 'in-progress' LIMIT 1",
    )
    .get(providerId, date) as Row | undefined;
  return r ? toAppointment(r) : undefined;
}

export function nextScheduledAppointment(providerId: string, date: string): Appointment | undefined {
  const r = getDb()
    .prepare(
      "SELECT * FROM appointments WHERE provider_id = ? AND substr(start,1,10) = ? AND status = 'scheduled' ORDER BY start LIMIT 1",
    )
    .get(providerId, date) as Row | undefined;
  return r ? toAppointment(r) : undefined;
}

export function providerAppointments(providerId: string): Appointment[] {
  return (
    getDb().prepare("SELECT * FROM appointments WHERE provider_id = ? ORDER BY start").all(providerId) as Row[]
  ).map(toAppointment);
}

// ---------------------------------------------------------------------------
// Slots
// ---------------------------------------------------------------------------

export function listOpenSlots(orgId: string, opts: { providerId?: string; date?: string } = {}): Slot[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM slots
       WHERE organization_id = @org AND taken = 0
         AND (@providerId IS NULL OR provider_id = @providerId)
         AND (@date IS NULL OR substr(start, 1, 10) = @date)
       ORDER BY start`,
    )
    .all({ org: orgId, providerId: opts.providerId ?? null, date: opts.date ?? null }) as Row[];
  return rows.map(toSlot);
}

export function getSlot(id: string): Slot | undefined {
  const r = getDb().prepare("SELECT * FROM slots WHERE id = ?").get(id) as Row | undefined;
  return r ? toSlot(r) : undefined;
}

export function freeSlotCount(providerId: string, date: string): number {
  return (
    getDb()
      .prepare("SELECT COUNT(*) AS n FROM slots WHERE provider_id = ? AND taken = 0 AND substr(start,1,10) = ?")
      .get(providerId, date) as { n: number }
  ).n;
}

// ---------------------------------------------------------------------------
// Invoices / labs
// ---------------------------------------------------------------------------

export function getInvoicesForPatient(patientId: string, orgId?: string): Invoice[] {
  const rows = orgId
    ? (getDb()
        .prepare("SELECT * FROM invoices WHERE patient_id = ? AND organization_id = ? ORDER BY date")
        .all(patientId, orgId) as Row[])
    : (getDb().prepare("SELECT * FROM invoices WHERE patient_id = ? ORDER BY date").all(patientId) as Row[]);
  return rows.map(toInvoice);
}

export function getInvoice(id: string): Invoice | undefined {
  const r = getDb().prepare("SELECT * FROM invoices WHERE id = ?").get(id) as Row | undefined;
  return r ? toInvoice(r) : undefined;
}

export function getLabResultsForPatient(patientId: string, orgId?: string): LabResult[] {
  const rows = orgId
    ? (getDb()
        .prepare("SELECT * FROM lab_results WHERE patient_id = ? AND organization_id = ? ORDER BY date DESC")
        .all(patientId, orgId) as Row[])
    : (getDb()
        .prepare("SELECT * FROM lab_results WHERE patient_id = ? ORDER BY date DESC")
        .all(patientId) as Row[]);
  return rows.map(toLab);
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

export function bookSlot(args: {
  organizationId: string;
  patientId: string;
  slotId: string;
  reason: string;
  createdVia?: Appointment["createdVia"];
}): Appointment {
  const db = getDb();
  return db.transaction(() => {
    const slot = getSlot(args.slotId);
    if (!slot) throw new Error(`El horario ${args.slotId} no existe.`);
    if (slot.taken) throw new Error(`El horario ${args.slotId} ya está ocupado.`);
    db.prepare("UPDATE slots SET taken = 1 WHERE id = ?").run(args.slotId);
    const id = uid("apt");
    db.prepare(
      `INSERT INTO appointments (id, organization_id, patient_id, provider_id, start, duration_minutes, reason, status, created_via)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'scheduled', ?)`,
    ).run(
      id,
      args.organizationId,
      args.patientId,
      slot.providerId,
      slot.start,
      slot.durationMinutes,
      args.reason,
      args.createdVia ?? "agent",
    );
    return getAppointment(id)!;
  })();
}

export function cancelAppointmentById(id: string): Appointment {
  const db = getDb();
  const apt = getAppointment(id);
  if (!apt) throw new Error(`El turno ${id} no existe.`);
  db.prepare("UPDATE appointments SET status = 'cancelled' WHERE id = ?").run(id);
  db.prepare("UPDATE slots SET taken = 0 WHERE provider_id = ? AND start = ?").run(apt.providerId, apt.start);
  return getAppointment(id)!;
}

export function createPrescriptionRequest(args: {
  organizationId: string;
  patientId: string;
  medication: string;
  decision: "approved" | "denied";
  decidedBy?: string;
  note?: string;
}): PrescriptionRequest {
  const id = uid("rx");
  const requestedAt = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO prescription_requests (id, organization_id, patient_id, medication, requested_at, status, decided_by, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      args.organizationId,
      args.patientId,
      args.medication,
      requestedAt,
      args.decision === "approved" ? "approved" : "denied",
      args.decidedBy ?? null,
      args.note ?? null,
    );
  return {
    id,
    patientId: args.patientId,
    medication: args.medication,
    requestedAt,
    status: args.decision === "approved" ? "approved" : "denied",
    decidedBy: args.decidedBy,
    note: args.note,
  };
}

export function recordPatientMessage(orgId: string, patientId: string, body: string): PatientMessage {
  const id = uid("msg");
  const sentAt = new Date().toISOString();
  getDb()
    .prepare("INSERT INTO patient_messages (id, organization_id, patient_id, body, sent_at) VALUES (?, ?, ?, ?, ?)")
    .run(id, orgId, patientId, body, sentAt);
  return { id, patientId, body, sentAt };
}

export function refundInvoice(id: string): Invoice {
  const inv = getInvoice(id);
  if (!inv) throw new Error(`La factura ${id} no existe.`);
  getDb().prepare("UPDATE invoices SET status = 'refunded' WHERE id = ?").run(id);
  return getInvoice(id)!;
}

// ---------------------------------------------------------------------------
// Pricing
// ---------------------------------------------------------------------------

export function listProviderPrices(providerId: string): PriceItem[] {
  return (
    getDb()
      .prepare("SELECT id, label, amount FROM provider_prices WHERE provider_id = ? ORDER BY label")
      .all(providerId) as Row[]
  ).map((r) => ({ id: r.id as string, label: r.label as string, amount: r.amount as number }));
}

export function setProviderFee(providerId: string, amount: number): void {
  getDb().prepare("UPDATE providers SET default_fee = ? WHERE id = ?").run(Math.round(amount), providerId);
}

export function addProviderPrice(orgId: string, providerId: string, label: string, amount: number): PriceItem {
  const id = uid("price");
  getDb()
    .prepare("INSERT INTO provider_prices (id, organization_id, provider_id, label, amount) VALUES (?, ?, ?, ?, ?)")
    .run(id, orgId, providerId, label.trim(), Math.round(amount));
  return { id, label: label.trim(), amount: Math.round(amount) };
}

export function priceForReason(providerId: string, reason: string): number {
  const r = reason.trim().toLowerCase();
  const match = listProviderPrices(providerId).find(
    (p) => r.includes(p.label.toLowerCase()) || p.label.toLowerCase().includes(r),
  );
  return match ? match.amount : getProvider(providerId)?.defaultFee ?? 0;
}

export function setAppointmentStatus(id: string, status: Appointment["status"]): void {
  getDb().prepare("UPDATE appointments SET status = ? WHERE id = ?").run(status, id);
}

export function setAppointmentPrice(id: string, price: number): void {
  getDb().prepare("UPDATE appointments SET price = ? WHERE id = ?").run(Math.round(price), id);
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

export function buildDayReport(orgId: string, date: string, providerId?: string): DayReport {
  const providers = (providerId ? [getProvider(providerId)].filter(Boolean) : listProviders(orgId)) as Provider[];
  const rows = getDb()
    .prepare("SELECT * FROM appointments WHERE organization_id = ? AND substr(start, 1, 10) = ?")
    .all(orgId, date) as Row[];
  const appts = rows.map(toAppointment);

  const perProvider: ProviderDayReport[] = providers.map((prov) => {
    const mine = appts.filter((a) => a.providerId === prov.id);
    const attended = mine.filter((a) => a.status === "completed");
    return {
      providerId: prov.id,
      providerName: prov.name,
      specialty: prov.specialty,
      attended: attended
        .sort((a, b) => a.start.localeCompare(b.start))
        .map((a) => ({
          patient: getPatient(a.patientId)?.fullName ?? a.patientId,
          reason: a.reason,
          time: a.start.slice(11, 16),
          price: a.price,
        })),
      attendedCount: attended.length,
      cancelledCount: mine.filter((a) => a.status === "cancelled").length,
      stillScheduled: mine.filter((a) => a.status === "scheduled").length,
      revenue: attended.reduce((s, a) => s + a.price, 0),
    };
  });

  return {
    date,
    clinicRevenue: perProvider.reduce((s, p) => s + p.revenue, 0),
    totalAttended: perProvider.reduce((s, p) => s + p.attendedCount, 0),
    providers: perProvider,
  };
}

export function saveDailyReport(
  orgId: string,
  date: string,
  providerId: string,
  generatedBy: string,
  payload: unknown,
): void {
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO daily_reports (organization_id, date, provider_id, generated_at, generated_by, payload)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(orgId, date, providerId, new Date().toISOString(), generatedBy, JSON.stringify(payload));
}

export function getSavedDailyReport(
  orgId: string,
  date: string,
  providerId: string,
): { generatedAt: string; generatedBy?: string; payload: unknown } | undefined {
  const r = getDb()
    .prepare("SELECT * FROM daily_reports WHERE organization_id = ? AND date = ? AND provider_id = ?")
    .get(orgId, date, providerId) as Row | undefined;
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

export function isBirthday(patientId: string, date: string): boolean {
  const p = getPatient(patientId);
  return Boolean(p && p.dateOfBirth.slice(5) === date.slice(5));
}

function initialClock(providerId: string, date: string): string {
  const r = getDb()
    .prepare(
      `SELECT start FROM appointments
       WHERE provider_id = ? AND substr(start,1,10) = ? AND status IN ('scheduled','in-progress')
       ORDER BY start LIMIT 1`,
    )
    .get(providerId, date) as { start?: string } | undefined;
  return r?.start ?? `${date}T09:00:00`;
}

export function getClinicClock(providerId: string, date: string): string {
  const r = getDb()
    .prepare("SELECT clock FROM clinic_state WHERE date = ? AND provider_id = ?")
    .get(date, providerId) as { clock?: string } | undefined;
  if (r?.clock) return r.clock;
  const c = initialClock(providerId, date);
  const orgId = getProvider(providerId)?.organizationId ?? "";
  getDb()
    .prepare("INSERT OR REPLACE INTO clinic_state (organization_id, date, provider_id, clock) VALUES (?, ?, ?, ?)")
    .run(orgId, date, providerId, c);
  return c;
}

export function setClinicClock(providerId: string, date: string, iso: string): void {
  const orgId = getProvider(providerId)?.organizationId ?? "";
  getDb()
    .prepare("INSERT OR REPLACE INTO clinic_state (organization_id, date, provider_id, clock) VALUES (?, ?, ?, ?)")
    .run(orgId, date, providerId, iso);
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

export function providerAgenda(providerId: string, date: string): ProviderAgenda {
  const clock = getClinicClock(providerId, date);
  const appts = (
    getDb()
      .prepare("SELECT * FROM appointments WHERE provider_id = ? AND substr(start,1,10) = ? ORDER BY start")
      .all(providerId, date) as Row[]
  ).map(toAppointment);

  const active = appts.find((a) => a.status === "in-progress");
  const pending = appts.filter((a) => a.status === "scheduled");
  const ref = active ?? pending[0];
  const offset = ref ? Math.round(minutesBetween(ref.start, clock)) : 0;
  const late = Math.max(0, offset);

  const entry = (a: Appointment): AgendaEntry => {
    const est = addMinutes(a.start, late);
    return {
      appointmentId: a.id,
      patientId: a.patientId,
      patientName: getPatient(a.patientId)?.fullName ?? a.patientId,
      reason: a.reason,
      status: a.status,
      scheduled: hm(a.start),
      estimated: hm(est),
      delayMinutes: Math.round(minutesBetween(a.start, est)),
      isBirthday: isBirthday(a.patientId, date),
    };
  };

  return {
    providerId,
    providerName: getProvider(providerId)?.name ?? providerId,
    date,
    clock: hm(clock),
    running: offset > 5 ? "atrasada" : offset < -5 ? "adelantada" : "en horario",
    offsetMinutes: offset,
    inAttention: active ? entry(active) : undefined,
    next: pending[0] ? entry(pending[0]) : undefined,
    upcoming: pending.slice(1).map(entry),
    attendedToday: appts.filter((a) => a.status === "completed").length,
  };
}

export function startAttention(appointmentId: string): Appointment {
  const a = getAppointment(appointmentId);
  if (!a) throw new Error(`El turno ${appointmentId} no existe.`);
  if (a.status !== "scheduled") throw new Error(`El turno está ${a.status}, no se puede iniciar.`);
  const clock = getClinicClock(a.providerId, dayOf(a.start));
  getDb()
    .prepare("UPDATE appointments SET status = 'in-progress', actual_start = ? WHERE id = ?")
    .run(clock, appointmentId);
  return getAppointment(appointmentId)!;
}

export function finishAttention(appointmentId: string, actualMinutes?: number): Appointment {
  const a = getAppointment(appointmentId);
  if (!a) throw new Error(`El turno ${appointmentId} no existe.`);
  const date = dayOf(a.start);
  const startedAt = a.actualStart ?? getClinicClock(a.providerId, date);
  const dur = Math.max(1, Math.round(actualMinutes ?? a.durationMinutes));
  const endAt = addMinutes(startedAt, dur);
  getDb()
    .prepare(
      "UPDATE appointments SET status = 'completed', actual_end = ?, actual_start = COALESCE(actual_start, ?) WHERE id = ?",
    )
    .run(endAt, startedAt, appointmentId);
  setClinicClock(a.providerId, date, endAt);
  return getAppointment(appointmentId)!;
}

/** Patient's next scheduled/in-progress appointment across the given orgs. */
export function patientNextAppointment(patientId: string, date: string, orgIds: string[]): Appointment | undefined {
  const rows = getDb()
    .prepare(
      `SELECT * FROM appointments
       WHERE patient_id = ? AND substr(start,1,10) = ? AND status IN ('scheduled','in-progress')
       ORDER BY start`,
    )
    .all(patientId, date) as Row[];
  return rows.map(toAppointment).find((a) => orgIds.includes(a.organizationId));
}

export function replacePatientNotice(
  orgId: string,
  appointmentId: string,
  patientId: string,
  date: string,
  message: string,
): void {
  const db = getDb();
  db.prepare("UPDATE patient_notices SET resolved = 1 WHERE appointment_id = ? AND resolved = 0").run(appointmentId);
  db.prepare(
    "INSERT INTO patient_notices (id, organization_id, appointment_id, patient_id, date, created_at, message, resolved) VALUES (?, ?, ?, ?, ?, ?, ?, 0)",
  ).run(uid("ntc"), orgId, appointmentId, patientId, date, new Date().toISOString(), message);
}

export function listPatientNotices(
  patientId: string,
  date: string,
): { id: string; message: string; createdAt: string }[] {
  return (
    getDb()
      .prepare(
        "SELECT id, message, created_at FROM patient_notices WHERE patient_id = ? AND date = ? AND resolved = 0 ORDER BY created_at",
      )
      .all(patientId, date) as Row[]
  ).map((r) => ({ id: r.id as string, message: r.message as string, createdAt: r.created_at as string }));
}

export function resolvePatientNotice(id: string): void {
  getDb().prepare("UPDATE patient_notices SET resolved = 1 WHERE id = ?").run(id);
}

export function clearNoticesForAppointment(appointmentId: string): void {
  getDb()
    .prepare("UPDATE patient_notices SET resolved = 1 WHERE appointment_id = ? AND resolved = 0")
    .run(appointmentId);
}

export function earlierOpeningToday(
  providerId: string,
  date: string,
  beforeHm: string,
): { slotId: string; time: string } | undefined {
  const clockHm = hm(getClinicClock(providerId, date));
  const rows = getDb()
    .prepare("SELECT id, start FROM slots WHERE provider_id = ? AND taken = 0 AND substr(start,1,10) = ? ORDER BY start")
    .all(providerId, date) as Row[];
  for (const r of rows) {
    const t = (r.start as string).slice(11, 16);
    if (t >= clockHm && t < beforeHm) return { slotId: r.id as string, time: t };
  }
  return undefined;
}
