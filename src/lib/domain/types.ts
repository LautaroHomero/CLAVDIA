// Domain model for a small medical practice.
// This is a mock in-memory dataset — see `store.ts`.

export type ISODate = string; // e.g. "2026-09-14"
export type ISODateTime = string; // e.g. "2026-09-14T10:30:00"

export interface Patient {
  id: string;
  fullName: string;
  dni: string; // national ID
  dateOfBirth: ISODate;
  phone: string;
  email: string;
  coverage: string; // insurer / plan
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
  amount: number; // in ARS
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
