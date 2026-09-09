import { randomUUID } from "node:crypto";
import type {
  Appointment,
  Invoice,
  LabResult,
  Medication,
  Patient,
  PatientMessage,
  PrescriptionRequest,
  PriceItem,
  Provider,
  Role,
  Slot,
  User,
} from "@/lib/domain/types";
import { DEMO_TODAY } from "@/lib/domain/clock";
import { getDb } from "./connection";
import { generateSlotRows } from "./slots";

const TODAY = DEMO_TODAY;

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
    defaultFee: (r.default_fee as number) ?? 0,
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
    price: (r.price as number) ?? 0,
    actualStart: (r.actual_start as string) ?? undefined,
    actualEnd: (r.actual_end as string) ?? undefined,
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

export function providerNameTaken(name: string): boolean {
  const target = normName(name);
  return (getDb().prepare("SELECT name FROM providers").all() as Row[]).some(
    (r) => normName(r.name as string) === target,
  );
}

/** Creates a professional (provider + login) and seeds their bookable slots. */
export function createProfessional(args: {
  name: string;
  specialty: string;
  roomLabel: string;
  pinHash: string;
  pinSalt: string;
}): { provider: Provider; userId: string } {
  const db = getDb();
  const providerId = `prov_${randomUUID().slice(0, 8)}`;
  const userId = `u_${randomUUID().slice(0, 8)}`;
  const tx = db.transaction(() => {
    db.prepare(
      "INSERT INTO providers (id, name, specialty, room_label) VALUES (?, ?, ?, ?)",
    ).run(providerId, args.name.trim(), args.specialty.trim(), args.roomLabel.trim());

    const slot = db.prepare(
      "INSERT INTO slots (id, provider_id, start, duration_minutes, taken) VALUES (?, ?, ?, 30, 0)",
    );
    for (const s of generateSlotRows(providerId)) slot.run(s.id, s.providerId, s.start);

    db.prepare(
      "INSERT INTO users (id, name, role, pin_hash, pin_salt, provider_id) VALUES (?, ?, 'medico', ?, ?, ?)",
    ).run(userId, args.name.trim(), args.pinHash, args.pinSalt, providerId);
  });
  tx();
  return { provider: getProvider(providerId)!, userId };
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

/** Agenda view: upcoming + in-progress appointments, optionally filtered. */
export function listAppointments(opts: { providerId?: string; date?: string } = {}): Appointment[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM appointments
       WHERE status IN ('scheduled', 'in-progress')
         AND (@providerId IS NULL OR provider_id = @providerId)
         AND (@date IS NULL OR substr(start, 1, 10) = @date)
       ORDER BY start`,
    )
    .all({ providerId: opts.providerId ?? null, date: opts.date ?? null }) as Row[];
  return rows.map(toAppointment);
}

/** The appointment a provider is currently in, if any. */
export function inProgressAppointment(providerId: string, date: string): Appointment | undefined {
  const r = getDb()
    .prepare(
      "SELECT * FROM appointments WHERE provider_id = ? AND substr(start,1,10) = ? AND status = 'in-progress' LIMIT 1",
    )
    .get(providerId, date) as Row | undefined;
  return r ? toAppointment(r) : undefined;
}

/** The provider's next not-yet-started appointment for a day. */
export function nextScheduledAppointment(providerId: string, date: string): Appointment | undefined {
  const r = getDb()
    .prepare(
      "SELECT * FROM appointments WHERE provider_id = ? AND substr(start,1,10) = ? AND status = 'scheduled' ORDER BY start LIMIT 1",
    )
    .get(providerId, date) as Row | undefined;
  return r ? toAppointment(r) : undefined;
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

export function addProviderPrice(providerId: string, label: string, amount: number): PriceItem {
  const id = `price_${randomUUID().slice(0, 8)}`;
  getDb()
    .prepare("INSERT INTO provider_prices (id, provider_id, label, amount) VALUES (?, ?, ?, ?)")
    .run(id, providerId, label.trim(), Math.round(amount));
  return { id, label: label.trim(), amount: Math.round(amount) };
}

/** Resolve what a given reason costs for a provider: matched price item, else default fee. */
export function priceForReason(providerId: string, reason: string): number {
  const r = reason.trim().toLowerCase();
  const match = listProviderPrices(providerId).find(
    (p) => r.includes(p.label.toLowerCase()) || p.label.toLowerCase().includes(r),
  );
  if (match) return match.amount;
  return getProvider(providerId)?.defaultFee ?? 0;
}

export function setAppointmentStatus(id: string, status: Appointment["status"]): void {
  getDb().prepare("UPDATE appointments SET status = ? WHERE id = ?").run(status, id);
}

export function setAppointmentPrice(id: string, price: number): void {
  getDb().prepare("UPDATE appointments SET price = ? WHERE id = ?").run(Math.round(price), id);
}

// ---------------------------------------------------------------------------
// Daily reports
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

export function buildDayReport(date: string, providerId?: string): DayReport {
  const providers = (providerId ? [getProvider(providerId)].filter(Boolean) : listProviders()) as Provider[];
  const rows = getDb()
    .prepare("SELECT * FROM appointments WHERE substr(start, 1, 10) = ?")
    .all(date) as Row[];
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
  date: string,
  providerId: string,
  generatedBy: string,
  payload: unknown,
): void {
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO daily_reports (date, provider_id, generated_at, generated_by, payload)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(date, providerId, new Date().toISOString(), generatedBy, JSON.stringify(payload));
}

export function getSavedDailyReport(
  date: string,
  providerId: string,
): { generatedAt: string; generatedBy?: string; payload: unknown } | undefined {
  const r = getDb()
    .prepare("SELECT * FROM daily_reports WHERE date = ? AND provider_id = ?")
    .get(date, providerId) as Row | undefined;
  if (!r) return undefined;
  return {
    generatedAt: r.generated_at as string,
    generatedBy: (r.generated_by as string) ?? undefined,
    payload: JSON.parse(r.payload as string),
  };
}

// ---------------------------------------------------------------------------
// Live agenda: running clock, start/finish a visit, delay notices
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
  getDb()
    .prepare("INSERT OR REPLACE INTO clinic_state (date, provider_id, clock) VALUES (?, ?, ?)")
    .run(date, providerId, c);
  return c;
}

export function setClinicClock(providerId: string, date: string, iso: string): void {
  getDb()
    .prepare("INSERT OR REPLACE INTO clinic_state (date, provider_id, clock) VALUES (?, ?, ?)")
    .run(date, providerId, iso);
}

export interface AgendaEntry {
  appointmentId: string;
  patientId: string;
  patientName: string;
  reason: string;
  status: Appointment["status"];
  scheduled: string; // HH:MM
  estimated: string; // HH:MM
  delayMinutes: number;
  isBirthday: boolean;
}

export interface ProviderAgenda {
  providerId: string;
  providerName: string;
  date: string;
  clock: string; // HH:MM
  running: "en horario" | "atrasada" | "adelantada";
  offsetMinutes: number; // + = atrasada
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
  const date = dayOf(a.start);
  const clock = getClinicClock(a.providerId, date);
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

export function patientAppointmentToday(patientId: string, date: string): Appointment | undefined {
  const r = getDb()
    .prepare(
      `SELECT * FROM appointments
       WHERE patient_id = ? AND substr(start,1,10) = ? AND status IN ('scheduled','in-progress')
       ORDER BY start LIMIT 1`,
    )
    .get(patientId, date) as Row | undefined;
  return r ? toAppointment(r) : undefined;
}

export function replacePatientNotice(
  appointmentId: string,
  patientId: string,
  date: string,
  message: string,
): void {
  const db = getDb();
  db.prepare("UPDATE patient_notices SET resolved = 1 WHERE appointment_id = ? AND resolved = 0").run(
    appointmentId,
  );
  db.prepare(
    "INSERT INTO patient_notices (id, appointment_id, patient_id, date, created_at, message, resolved) VALUES (?, ?, ?, ?, ?, ?, 0)",
  ).run(`ntc_${randomUUID().slice(0, 8)}`, appointmentId, patientId, date, new Date().toISOString(), message);
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

/** An open slot for this provider today, after the clock and before `beforeHm`. */
export function earlierOpeningToday(
  providerId: string,
  date: string,
  beforeHm: string,
): { slotId: string; time: string } | undefined {
  const clockHm = hm(getClinicClock(providerId, date));
  const rows = getDb()
    .prepare(
      "SELECT id, start FROM slots WHERE provider_id = ? AND taken = 0 AND substr(start,1,10) = ? ORDER BY start",
    )
    .all(providerId, date) as Row[];
  for (const r of rows) {
    const t = (r.start as string).slice(11, 16);
    if (t >= clockHm && t < beforeHm) return { slotId: r.id as string, time: t };
  }
  return undefined;
}
