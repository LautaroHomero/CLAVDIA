// Domain model for a small medical practice, backed by SQLite (see src/lib/db).

export type ISODate = string; // "2026-09-14"
export type ISODateTime = string; // "2026-09-14T10:30:00"

export type Role = "medico" | "recepcion" | "paciente";

export interface User {
  id: string;
  name: string;
  role: Role;
  /** Set when role === "paciente": the patient record this user is. */
  patientId?: string;
  /** Set when role === "medico": the provider record this user is. */
  providerId?: string;
}

/** Who is talking to the agent — derived from the session, passed into the workflow. */
export interface Actor {
  userId: string;
  name: string;
  role: Role;
  patientId?: string;
  providerId?: string;
  /** For role === "medico": the professional's specialty, e.g. "Dermatología". */
  specialty?: string;
}

export interface Patient {
  id: string;
  fullName: string;
  dni: string;
  dateOfBirth: ISODate;
  phone: string;
  email: string;
  coverage: string;
  allergies: string[];
  activeConditions: string[];
  medications: Medication[];
  notes?: string;
}

export interface Medication {
  name: string;
  dose: string;
  lastPrescribed: ISODate;
  chronic: boolean;
}

export type AppointmentStatus = "scheduled" | "cancelled" | "completed";

export interface Appointment {
  id: string;
  patientId: string;
  providerId: string;
  start: ISODateTime;
  durationMinutes: number;
  reason: string;
  status: AppointmentStatus;
  createdVia: "agent" | "front-desk";
}

export interface Provider {
  id: string;
  name: string;
  specialty: string;
  roomLabel: string;
}

export interface Slot {
  id: string;
  providerId: string;
  start: ISODateTime;
  durationMinutes: number;
  taken: boolean;
}

export type InvoiceStatus = "paid" | "unpaid" | "refunded";

export interface Invoice {
  id: string;
  patientId: string;
  date: ISODate;
  concept: string;
  amount: number; // ARS
  status: InvoiceStatus;
}

export interface LabResult {
  id: string;
  patientId: string;
  date: ISODate;
  panel: string;
  status: "pending-review" | "reviewed";
  summary: string;
}

export interface PrescriptionRequest {
  id: string;
  patientId: string;
  medication: string;
  requestedAt: ISODateTime;
  status: "awaiting-doctor" | "approved" | "denied";
  decidedBy?: string;
  note?: string;
}

export interface PatientMessage {
  id: string;
  patientId: string;
  body: string;
  sentAt: ISODateTime;
}
