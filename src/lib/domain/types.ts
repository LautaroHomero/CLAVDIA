// Domain model for a small medical practice, backed by SQLite (see src/lib/db).

export type ISODate = string; // "2026-09-14"
export type ISODateTime = string; // "2026-09-14T10:30:00"

export type Role = "medico" | "recepcion" | "paciente";
export type StaffRole = "medico" | "recepcion";

export interface Organization {
  id: string;
  name: string;
  slug: string;
  address: string;
  hours: string;
  phone: string;
}

export interface OrgRef {
  id: string;
  name: string;
}

/** A staff user's active organization for the session. */
export interface StaffOrg extends OrgRef {
  role: StaffRole;
  providerId?: string; // for medico
  specialty?: string;
}

export interface User {
  id: string;
  name: string;
  role: Role;
  patientId?: string;
}

/**
 * Who is talking to the agent — rehydrated from the session on every request.
 * `activeOrg` is set for staff (the org they chose at login). Patients operate
 * across all `orgs` they belong to.
 */
export interface Actor {
  userId: string;
  name: string;
  role: Role;
  patientId?: string;
  activeOrg?: StaffOrg;
  orgs: OrgRef[];
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

export type AppointmentStatus = "scheduled" | "in-progress" | "cancelled" | "completed";

export interface Appointment {
  id: string;
  organizationId: string;
  patientId: string;
  providerId: string;
  start: ISODateTime;
  durationMinutes: number;
  reason: string;
  status: AppointmentStatus;
  price: number; // ARS, resolved at scheduling time
  actualStart?: ISODateTime; // set when the professional starts the visit
  actualEnd?: ISODateTime;
  createdVia: "agent" | "front-desk";
}

export interface Provider {
  id: string;
  organizationId: string;
  name: string;
  specialty: string;
  roomLabel: string;
  defaultFee: number; // ARS per standard consultation
}

export interface PriceItem {
  id: string;
  label: string;
  amount: number;
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
  organizationId: string;
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
