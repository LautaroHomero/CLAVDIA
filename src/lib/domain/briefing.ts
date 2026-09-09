import {
  getInvoicesForPatient,
  getLabResultsForPatient,
  getPatient,
  getProvider,
  getUpcomingAppointments,
} from "@/lib/db/repo";
import { DEMO_TODAY } from "./clock";

export interface PatientBriefing {
  found: boolean;
  patientId?: string;
  summary: string;
  data?: {
    fullName: string;
    age: number;
    dni: string;
    coverage: string;
    allergies: string[];
    activeConditions: string[];
    medications: { name: string; dose: string; lastPrescribed: string; chronic: boolean }[];
    upcomingAppointments: { id: string; when: string; provider: string; reason: string }[];
    outstandingInvoices: { id: string; concept: string; amount: number; date: string }[];
    pendingLabResults: { id: string; panel: string; date: string; summary: string }[];
    notes?: string;
  };
}

function ageFrom(dob: string): number {
  const birth = new Date(`${dob}T00:00:00`);
  const now = new Date(`${DEMO_TODAY}T00:00:00`);
  let age = now.getFullYear() - birth.getFullYear();
  const m = now.getMonth() - birth.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < birth.getDate())) age--;
  return age;
}

/**
 * Compiles the "pre-visit briefing" the agent shows before attending a patient.
 * Scoped to `orgId` when given (a professional sees their own org's turns,
 * invoices and labs — the ficha itself is global).
 */
export function buildPatientBriefing(patientId: string, orgId?: string): PatientBriefing {
  const patient = getPatient(patientId);
  if (!patient) {
    return {
      found: false,
      summary: `No se encontró ningún paciente con id "${patientId}".`,
    };
  }

  const age = ageFrom(patient.dateOfBirth);
  const orgFilter = orgId ? [orgId] : undefined;
  const upcoming = getUpcomingAppointments(patient.id, orgFilter).map((a) => ({
    id: a.id,
    when: a.start.replace("T", " "),
    provider: getProvider(a.providerId)?.name ?? a.providerId,
    reason: a.reason,
  }));
  const outstanding = getInvoicesForPatient(patient.id, orgId)
    .filter((i) => i.status === "unpaid")
    .map((i) => ({ id: i.id, concept: i.concept, amount: i.amount, date: i.date }));
  const pendingLabs = getLabResultsForPatient(patient.id, orgId)
    .filter((l) => l.status === "pending-review")
    .map((l) => ({ id: l.id, panel: l.panel, date: l.date, summary: l.summary }));

  const lines: string[] = [];
  lines.push(`${patient.fullName} · ${age} años · DNI ${patient.dni} · ${patient.coverage}`);
  lines.push(
    `Antecedentes: ${patient.activeConditions.length ? patient.activeConditions.join(", ") : "sin condiciones activas registradas"}.`,
  );
  lines.push(
    `Alergias: ${patient.allergies.length ? patient.allergies.join(", ") : "no registra"}.`,
  );
  if (patient.medications.length) {
    lines.push(
      `Medicación: ${patient.medications
        .map((m) => `${m.name} (${m.dose}${m.chronic ? ", crónica" : ""})`)
        .join("; ")}.`,
    );
  } else {
    lines.push("Medicación: no registra.");
  }
  lines.push(
    upcoming.length
      ? `Próximos turnos: ${upcoming.map((a) => `${a.when} con ${a.provider} (${a.reason})`).join("; ")}.`
      : "Próximos turnos: ninguno agendado.",
  );
  if (outstanding.length) {
    lines.push(
      `Facturas impagas: ${outstanding.map((i) => `${i.concept} $${i.amount.toLocaleString("es-AR")} (${i.id})`).join("; ")}.`,
    );
  }
  if (pendingLabs.length) {
    lines.push(
      `Resultados pendientes de revisión médica: ${pendingLabs.map((l) => `${l.panel} — ${l.summary}`).join("; ")}.`,
    );
  }
  if (patient.notes) lines.push(`Nota interna: ${patient.notes}`);

  return {
    found: true,
    patientId: patient.id,
    summary: lines.join("\n"),
    data: {
      fullName: patient.fullName,
      age,
      dni: patient.dni,
      coverage: patient.coverage,
      allergies: patient.allergies,
      activeConditions: patient.activeConditions,
      medications: patient.medications,
      upcomingAppointments: upcoming,
      outstandingInvoices: outstanding,
      pendingLabResults: pendingLabs,
      notes: patient.notes,
    },
  };
}
