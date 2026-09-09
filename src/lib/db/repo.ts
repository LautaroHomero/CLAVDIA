import { randomUUID } from "node:crypto";
import type {
  Appointment,
  Invoice,
  LabResult,
  Medication,
  Patient,
  PatientMessage,
  PrescriptionRequest,
  Provider,
  Role,
  Slot,
  User,
} from "@/lib/domain/types";
import { getDb } from "./connection";

const TODAY = "2026-09-09"; // demo "now"

// ---------------------------------------------------------------------------
// Row mappers
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

function toProvider(r: Row): Provider {
  return {
    id: r.id as string,
    name: r.name as string,
    specialty: r.specialty as string,
    roomLabel: r.room_label as string,
  };
}

function toMedication(r: Row): Medication {
  return {
    name: r.name as string,
    dose: r.dose as string,
    lastPrescribed: r.last_prescribed as string,
    chronic: Boolean(r.chronic),
  };
}

function toPatient(r: Row, meds: Medication[]): Patient {
  return {
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
  };
}

function toAppointment(r: Row): Appointment {
  return {
    id: r.id as string,
    patientId: r.patient_id as string,
    providerId: r.provider_id as string,
    start: r.start as string,
    durationMinutes: r.duration_minutes as number,
    reason: r.reason as string,
    status: r.status as Appointment["status"],
    createdVia: r.created_via as Appointment["createdVia"],
  };
}

function toSlot(r: Row): Slot {
  return {
    id: r.id as string,
    providerId: r.provider_id as string,
    start: r.start as string,
    durationMinutes: r.duration_minutes as number,
    taken: Boolean(r.taken),
  };
}

function toInvoice(r: Row): Invoice {
  return {
    id: r.id as string,
    patientId: r.patient_id as string,
    date: r.date as string,
    concept: r.concept as string,
    amount: r.amount as number,
    status: r.status as Invoice["status"],
  };
}

function toLab(r: Row): LabResult {
  return {
    id: r.id as string,
    patientId: r.patient_id as string,
    date: r.date as string,
    panel: r.panel as string,
    status: r.status as LabResult["status"],
    summary: r.summary as string,
  };
}

function toUser(r: Row): User {
  return {
    id: r.id as string,
    name: r.name as string,
    role: r.role as Role,
    patientId: (r.patient_id as string) ?? undefined,
    providerId: (r.provider_id as string) ?? undefined,
  };
}

// ---------------------------------------------------------------------------
// Users / auth
// ---------------------------------------------------------------------------

/** For the login picker — no secrets. */
export function listUsers(): (User & { role: Role })[] {
  return (getDb().prepare("SELECT * FROM users ORDER BY role, name").all() as Row[]).map(toUser);
}

export function getUser(id: string): User | undefined {
  const r = getDb().prepare("SELECT * FROM users WHERE id = ?").get(id) as Row | undefined;
  return r ? toUser(r) : undefined;
}

export function getUserWithPin(
  id: string,
): (User & { pinHash: string; pinSalt: string }) | undefined {
  const r = getDb().prepare("SELECT * FROM users WHERE id = ?").get(id) as Row | undefined;
  if (!r) return undefined;
  return { ...toUser(r), pinHash: r.pin_hash as string, pinSalt: r.pin_salt as string };
}

/** Normalize a name for matching: trim, lowercase, strip accents. */
function normName(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

/** Login by typed name (case- and accent-insensitive), optionally restricted to roles. */
export function getUserByName(
  name: string,
  roles?: Role[],
): (User & { pinHash: string; pinSalt: string }) | undefined {
  const target = normName(name);
  const rows = getDb().prepare("SELECT * FROM users").all() as Row[];
  const r = rows.find((row) => normName(row.name as string) === target);
  if (!r) return undefined;
  if (roles && !roles.includes(r.role as Role)) return undefined;
  return { ...toUser(r), pinHash: r.pin_hash as string, pinSalt: r.pin_salt as string };
}

export function userNameTaken(name: string): boolean {
  const target = normName(name);
  const rows = getDb().prepare("SELECT name FROM users").all() as Row[];
  return rows.some((row) => normName(row.name as string) === target);
}

/** Creates a login (used by patient self-signup and by the registerPatient tool). */
export function createPatientUser(args: {
  name: string;
  pinHash: string;
  pinSalt: string;
  patientId: string;
}): User {
  const id = `u_${randomUUID().slice(0, 8)}`;
  getDb()
    .prepare(
      "INSERT INTO users (id, name, role, pin_hash, pin_salt, patient_id) VALUES (?, ?, 'paciente', ?, ?, ?)",
    )
    .run(id, args.name.trim(), args.pinHash, args.pinSalt, args.patientId);
  return { id, name: args.name.trim(), role: "paciente", patientId: args.patientId };
}

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

export function listProviders(): Provider[] {
  return (getDb().prepare("SELECT * FROM providers ORDER BY name").all() as Row[]).map(toProvider);
}

export function getProvider(id: string): Provider | undefined {
  const r = getDb().prepare("SELECT * FROM providers WHERE id = ?").get(id) as Row | undefined;
  return r ? toProvider(r) : undefined;
}

// ---------------------------------------------------------------------------
// Patients
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

/** Inserts a patient record. Returns the created patient. */
export function createPatient(input: NewPatientInput): Patient {
  const id = `pat_${randomUUID().slice(0, 8)}`;
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

export function searchPatients(query: string): Patient[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const bare = q.replace(/\./g, "");
  const rows = getDb()
    .prepare(
      `SELECT * FROM patients
       WHERE lower(full_name) LIKE ?
          OR replace(dni, '.', '') LIKE ?
          OR lower(email) LIKE ?
          OR id = ?`,
    )
    .all(`%${q}%`, `%${bare}%`, `%${q}%`, q) as Row[];
  return rows.map((r) => toPatient(r, medsFor(r.id as string)));
}

// ---------------------------------------------------------------------------
// Appointments
// ---------------------------------------------------------------------------

export function getAppointment(id: string): Appointment | undefined {
  const r = getDb().prepare("SELECT * FROM appointments WHERE id = ?").get(id) as Row | undefined;
  return r ? toAppointment(r) : undefined;
}

export function getAppointmentsForPatient(patientId: string): Appointment[] {
  return (
    getDb()
      .prepare("SELECT * FROM appointments WHERE patient_id = ? ORDER BY start")
      .all(patientId) as Row[]
  ).map(toAppointment);
}

export function getUpcomingAppointments(patientId: string): Appointment[] {
  return getAppointmentsForPatient(patientId).filter(
    (a) => a.status === "scheduled" && a.start >= TODAY,
  );
}

/** Agenda view: scheduled appointments, optionally filtered by provider / date. */
export function listAppointments(opts: { providerId?: string; date?: string } = {}): Appointment[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM appointments
       WHERE status = 'scheduled'
         AND (@providerId IS NULL OR provider_id = @providerId)
         AND (@date IS NULL OR substr(start, 1, 10) = @date)
       ORDER BY start`,
    )
    .all({ providerId: opts.providerId ?? null, date: opts.date ?? null }) as Row[];
  return rows.map(toAppointment);
}

// ---------------------------------------------------------------------------
// Slots
// ---------------------------------------------------------------------------

export function listOpenSlots(opts: { providerId?: string; date?: string } = {}): Slot[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM slots
       WHERE taken = 0
         AND (@providerId IS NULL OR provider_id = @providerId)
         AND (@date IS NULL OR substr(start, 1, 10) = @date)
       ORDER BY start`,
    )
    .all({ providerId: opts.providerId ?? null, date: opts.date ?? null }) as Row[];
  return rows.map(toSlot);
}

export function getSlot(id: string): Slot | undefined {
  const r = getDb().prepare("SELECT * FROM slots WHERE id = ?").get(id) as Row | undefined;
  return r ? toSlot(r) : undefined;
}

// ---------------------------------------------------------------------------
// Invoices / labs
// ---------------------------------------------------------------------------

export function getInvoicesForPatient(patientId: string): Invoice[] {
  return (
    getDb().prepare("SELECT * FROM invoices WHERE patient_id = ? ORDER BY date").all(patientId) as Row[]
  ).map(toInvoice);
}

export function getInvoice(id: string): Invoice | undefined {
  const r = getDb().prepare("SELECT * FROM invoices WHERE id = ?").get(id) as Row | undefined;
  return r ? toInvoice(r) : undefined;
}

export function getLabResultsForPatient(patientId: string): LabResult[] {
  return (
    getDb().prepare("SELECT * FROM lab_results WHERE patient_id = ? ORDER BY date DESC").all(patientId) as Row[]
  ).map(toLab);
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

export function bookSlot(args: { patientId: string; slotId: string; reason: string }): Appointment {
  const db = getDb();
  const tx = db.transaction(() => {
    const slot = getSlot(args.slotId);
    if (!slot) throw new Error(`El horario ${args.slotId} no existe.`);
    if (slot.taken) throw new Error(`El horario ${args.slotId} ya está ocupado.`);
    db.prepare("UPDATE slots SET taken = 1 WHERE id = ?").run(args.slotId);
    const id = `apt_${randomUUID().slice(0, 8)}`;
    db.prepare(
      `INSERT INTO appointments (id, patient_id, provider_id, start, duration_minutes, reason, status, created_via)
       VALUES (?, ?, ?, ?, ?, ?, 'scheduled', 'agent')`,
    ).run(id, args.patientId, slot.providerId, slot.start, slot.durationMinutes, args.reason);
    return getAppointment(id)!;
  });
  return tx();
}

export function cancelAppointmentById(id: string): Appointment {
  const db = getDb();
  const apt = getAppointment(id);
  if (!apt) throw new Error(`El turno ${id} no existe.`);
  db.prepare("UPDATE appointments SET status = 'cancelled' WHERE id = ?").run(id);
  db.prepare("UPDATE slots SET taken = 0 WHERE provider_id = ? AND start = ?").run(
    apt.providerId,
    apt.start,
  );
  return getAppointment(id)!;
}

export function createPrescriptionRequest(args: {
  patientId: string;
  medication: string;
  decision: "approved" | "denied";
  decidedBy?: string;
  note?: string;
}): PrescriptionRequest {
  const id = `rx_${randomUUID().slice(0, 8)}`;
  const requestedAt = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO prescription_requests (id, patient_id, medication, requested_at, status, decided_by, note)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
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

export function recordPatientMessage(patientId: string, body: string): PatientMessage {
  const id = `msg_${randomUUID().slice(0, 8)}`;
  const sentAt = new Date().toISOString();
  getDb()
    .prepare("INSERT INTO patient_messages (id, patient_id, body, sent_at) VALUES (?, ?, ?, ?)")
    .run(id, patientId, body, sentAt);
  return { id, patientId, body, sentAt };
}

export function refundInvoice(id: string): Invoice {
  const inv = getInvoice(id);
  if (!inv) throw new Error(`La factura ${id} no existe.`);
  getDb().prepare("UPDATE invoices SET status = 'refunded' WHERE id = ?").run(id);
  return getInvoice(id)!;
}
