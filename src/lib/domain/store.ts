import { randomUUID } from "node:crypto";
import type {
  Appointment,
  Invoice,
  LabResult,
  Patient,
  PatientMessage,
  PrescriptionRequest,
  Provider,
  Slot,
} from "./types";

/**
 * In-memory mock database for the demo.
 *
 * It is seeded fresh every time the server process starts, so reviewers get
 * predictable state on each `npm run dev`. In a real deployment this module
 * would be replaced by a database client (Postgres, etc.) — every read/write
 * below is already funnelled through small functions to make that swap easy.
 */

interface Db {
  patients: Patient[];
  providers: Provider[];
  slots: Slot[];
  appointments: Appointment[];
  invoices: Invoice[];
  labResults: LabResult[];
  prescriptionRequests: PrescriptionRequest[];
  messages: PatientMessage[];
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** Build bookable slots for the next `days` weekdays, 09:00–12:00, every 30'. */
function seedSlots(providerId: string, fromDaysAhead = 1, days = 6): Slot[] {
  const slots: Slot[] = [];
  const base = new Date("2026-09-09T00:00:00");
  let added = 0;
  let offset = fromDaysAhead;
  while (added < days) {
    const day = new Date(base);
    day.setDate(base.getDate() + offset);
    offset += 1;
    const weekday = day.getDay();
    if (weekday === 0 || weekday === 6) continue; // skip weekends
    added += 1;
    const dateStr = `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`;
    for (let h = 9; h < 12; h++) {
      for (const m of [0, 30]) {
        slots.push({
          id: `slot_${providerId}_${dateStr}_${pad(h)}${pad(m)}`,
          providerId,
          start: `${dateStr}T${pad(h)}:${pad(m)}:00`,
          durationMinutes: 30,
          taken: false,
        });
      }
    }
  }
  return slots;
}

function seed(): Db {
  const providers: Provider[] = [
    { id: "prov_ruiz", name: "Dra. Elena Ruiz", specialty: "Clínica Médica", roomLabel: "Consultorio 2" },
    { id: "prov_sosa", name: "Dr. Martín Sosa", specialty: "Cardiología", roomLabel: "Consultorio 5" },
  ];

  const patients: Patient[] = [
    {
      id: "pat_gomez",
      fullName: "María Gómez",
      dni: "28.444.123",
      dateOfBirth: "1981-03-12",
      phone: "+54 9 11 5555-1010",
      email: "maria.gomez@example.com",
      coverage: "OSDE 210",
      allergies: ["Penicilina"],
      activeConditions: ["Hipertensión arterial", "Hipotiroidismo"],
      medications: [
        { name: "Enalapril", dose: "10 mg / día", lastPrescribed: "2026-06-10", chronic: true },
        { name: "Levotiroxina", dose: "75 mcg / día", lastPrescribed: "2026-05-02", chronic: true },
      ],
      notes: "Prefiere turnos por la mañana. Controla presión en casa.",
    },
    {
      id: "pat_fernandez",
      fullName: "Jorge Fernández",
      dni: "20.999.888",
      dateOfBirth: "1959-11-30",
      phone: "+54 9 11 5555-2020",
      email: "jorge.fernandez@example.com",
      coverage: "PAMI",
      allergies: [],
      activeConditions: ["Fibrilación auricular", "Diabetes tipo 2"],
      medications: [
        { name: "Apixabán", dose: "5 mg c/12 h", lastPrescribed: "2026-08-20", chronic: true },
        { name: "Metformina", dose: "850 mg c/12 h", lastPrescribed: "2026-07-15", chronic: true },
      ],
      notes: "Anticoagulado: cualquier cambio de medicación lo define el Dr. Sosa.",
    },
    {
      id: "pat_ortiz",
      fullName: "Lucía Ortiz",
      dni: "39.222.777",
      dateOfBirth: "1997-07-08",
      phone: "+54 9 11 5555-3030",
      email: "lucia.ortiz@example.com",
      coverage: "Swiss Medical SMG20",
      allergies: ["Ibuprofeno"],
      activeConditions: [],
      medications: [],
      notes: "Consulta habitual por controles anuales.",
    },
    {
      id: "pat_gomez_2",
      fullName: "Mario Gómez",
      dni: "33.111.456",
      dateOfBirth: "1988-01-22",
      phone: "+54 9 11 5555-4040",
      email: "mario.gomez@example.com",
      coverage: "OSDE 310",
      allergies: [],
      activeConditions: ["Asma leve"],
      medications: [
        { name: "Salbutamol", dose: "según necesidad", lastPrescribed: "2026-04-01", chronic: false },
      ],
      notes: "Homónimo parcial de María Gómez — confirmar identidad por DNI.",
    },
  ];

  const appointments: Appointment[] = [
    {
      id: "apt_1001",
      patientId: "pat_gomez",
      providerId: "prov_ruiz",
      start: "2026-09-11T09:30:00",
      durationMinutes: 30,
      reason: "Control de presión arterial",
      status: "scheduled",
      createdVia: "front-desk",
    },
    {
      id: "apt_1002",
      patientId: "pat_fernandez",
      providerId: "prov_sosa",
      start: "2026-09-10T10:00:00",
      durationMinutes: 30,
      reason: "Control de anticoagulación",
      status: "scheduled",
      createdVia: "front-desk",
    },
  ];

  const invoices: Invoice[] = [
    { id: "inv_5001", patientId: "pat_gomez", date: "2026-08-15", concept: "Consulta clínica", amount: 18000, status: "paid" },
    { id: "inv_5002", patientId: "pat_fernandez", date: "2026-08-28", concept: "Consulta cardiología + ECG", amount: 42000, status: "unpaid" },
    { id: "inv_5003", patientId: "pat_ortiz", date: "2026-07-30", concept: "Chequeo anual", amount: 25000, status: "paid" },
    { id: "inv_5004", patientId: "pat_ortiz", date: "2026-08-30", concept: "Resonancia magnética de rodilla", amount: 180000, status: "paid" },
  ];

  const labResults: LabResult[] = [
    {
      id: "lab_7001",
      patientId: "pat_fernandez",
      date: "2026-09-05",
      panel: "RIN / coagulograma",
      status: "pending-review",
      summary: "RIN 3.8 (rango objetivo 2.0–3.0).",
    },
    {
      id: "lab_7002",
      patientId: "pat_gomez",
      date: "2026-08-14",
      panel: "Perfil tiroideo",
      status: "reviewed",
      summary: "TSH 2.1 — dentro de rango.",
    },
  ];

  return {
    patients,
    providers,
    slots: [...seedSlots("prov_ruiz"), ...seedSlots("prov_sosa")],
    appointments,
    invoices,
    labResults,
    prescriptionRequests: [],
    messages: [],
  };
}

// Survive Next.js hot-reload in dev by stashing the db on globalThis.
const globalForDb = globalThis as unknown as { __clinicDb?: Db };
const db: Db = globalForDb.__clinicDb ?? seed();
if (process.env.NODE_ENV !== "production") globalForDb.__clinicDb = db;

// ---------------------------------------------------------------------------
// Read helpers
// ---------------------------------------------------------------------------

export function listProviders(): Provider[] {
  return db.providers;
}

export function getProvider(id: string): Provider | undefined {
  return db.providers.find((p) => p.id === id);
}

export function getPatient(id: string): Patient | undefined {
  return db.patients.find((p) => p.id === id);
}

export function searchPatients(query: string): Patient[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return db.patients.filter((p) => {
    return (
      p.fullName.toLowerCase().includes(q) ||
      p.dni.replace(/\./g, "").includes(q.replace(/\./g, "")) ||
      p.id === q ||
      p.email.toLowerCase().includes(q)
    );
  });
}

export function getAppointmentsForPatient(patientId: string): Appointment[] {
  return db.appointments
    .filter((a) => a.patientId === patientId)
    .sort((a, b) => a.start.localeCompare(b.start));
}

export function getAppointment(id: string): Appointment | undefined {
  return db.appointments.find((a) => a.id === id);
}

export function getUpcomingAppointments(patientId: string): Appointment[] {
  return getAppointmentsForPatient(patientId).filter(
    (a) => a.status === "scheduled" && a.start >= "2026-09-09",
  );
}

export function listOpenSlots(opts: { providerId?: string; date?: string } = {}): Slot[] {
  return db.slots
    .filter((s) => !s.taken)
    .filter((s) => (opts.providerId ? s.providerId === opts.providerId : true))
    .filter((s) => (opts.date ? s.start.startsWith(opts.date) : true))
    .sort((a, b) => a.start.localeCompare(b.start));
}

export function getSlot(id: string): Slot | undefined {
  return db.slots.find((s) => s.id === id);
}

export function getInvoicesForPatient(patientId: string): Invoice[] {
  return db.invoices.filter((i) => i.patientId === patientId);
}

export function getInvoice(id: string): Invoice | undefined {
  return db.invoices.find((i) => i.id === id);
}

export function getLabResultsForPatient(patientId: string): LabResult[] {
  return db.labResults.filter((l) => l.patientId === patientId);
}

// ---------------------------------------------------------------------------
// Write helpers
// ---------------------------------------------------------------------------

export function bookSlot(args: {
  patientId: string;
  slotId: string;
  reason: string;
}): Appointment {
  const slot = getSlot(args.slotId);
  if (!slot) throw new Error(`Slot ${args.slotId} no existe`);
  if (slot.taken) throw new Error(`Slot ${args.slotId} ya está ocupado`);
  slot.taken = true;
  const appointment: Appointment = {
    id: `apt_${randomUUID().slice(0, 8)}`,
    patientId: args.patientId,
    providerId: slot.providerId,
    start: slot.start,
    durationMinutes: slot.durationMinutes,
    reason: args.reason,
    status: "scheduled",
    createdVia: "agent",
  };
  db.appointments.push(appointment);
  return appointment;
}

export function cancelAppointmentById(id: string, _reason: string): Appointment {
  const apt = getAppointment(id);
  if (!apt) throw new Error(`Turno ${id} no existe`);
  apt.status = "cancelled";
  const slot = db.slots.find((s) => s.start === apt.start && s.providerId === apt.providerId);
  if (slot) slot.taken = false;
  return apt;
}

export function createPrescriptionRequest(args: {
  patientId: string;
  medication: string;
  decision: "approved" | "denied";
  decidedBy?: string;
  note?: string;
}): PrescriptionRequest {
  const req: PrescriptionRequest = {
    id: `rx_${randomUUID().slice(0, 8)}`,
    patientId: args.patientId,
    medication: args.medication,
    requestedAt: new Date().toISOString(),
    status: args.decision === "approved" ? "approved" : "denied",
    decidedBy: args.decidedBy,
    note: args.note,
  };
  db.prescriptionRequests.push(req);
  return req;
}

export function recordPatientMessage(patientId: string, body: string): PatientMessage {
  const msg: PatientMessage = {
    id: `msg_${randomUUID().slice(0, 8)}`,
    patientId,
    body,
    sentAt: new Date().toISOString(),
  };
  db.messages.push(msg);
  return msg;
}

export function refundInvoice(id: string, _reason: string): Invoice {
  const inv = getInvoice(id);
  if (!inv) throw new Error(`Factura ${id} no existe`);
  inv.status = "refunded";
  return inv;
}
