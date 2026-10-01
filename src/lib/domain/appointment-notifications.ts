/**
 * Patient-facing email notifications around an appointment: booking
 * confirmation, cancellation notice, and the reminder sent by the cron
 * endpoint (`/api/cron/reminders`). Called from `scheduling.ts` — the single
 * place that books/cancels/reschedules — so both the agent tools and the
 * manual REST endpoints trigger the same emails without duplicating logic.
 *
 * Every function here is best-effort and never throws: a notification
 * failure (patient with no email on file, Resend down) must not break the
 * booking/cancel flow it's attached to. Failures are logged for follow-up.
 */
import { getOrganization, getPatient, getProvider } from "@/lib/db/repo";
import { getNotifier } from "@/lib/notify";
import type { Appointment, Organization, Patient, Provider } from "@/lib/domain/types";

const fmtWhen = (iso: string) =>
  new Date(iso).toLocaleString("es-AR", {
    weekday: "long",
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
  });

interface Ctx {
  patient: Patient;
  provider: Provider;
  organization: Organization;
}

async function loadContext(appointment: Appointment): Promise<Ctx | undefined> {
  const [patient, provider, organization] = await Promise.all([
    getPatient(appointment.patientId),
    getProvider(appointment.providerId),
    getOrganization(appointment.organizationId),
  ]);
  if (!patient?.email?.trim() || !provider || !organization) return undefined;
  return { patient, provider, organization };
}

async function notifyPatient(
  appointment: Appointment,
  subject: string,
  body: (ctx: Ctx) => string,
): Promise<void> {
  try {
    const ctx = await loadContext(appointment);
    if (!ctx) return; // no email on file, or provider/org missing — nothing to send
    await getNotifier().send({ channel: "email", to: ctx.patient.email, subject, body: body(ctx) });
  } catch (err) {
    console.error(`[notify] no se pudo notificar el turno ${appointment.id}:`, err);
  }
}

const whereLine = (organization: Organization) =>
  `Consultorio: ${organization.name}${organization.address ? ` (${organization.address})` : ""}`;

export async function notifyAppointmentBooked(appointment: Appointment): Promise<void> {
  await notifyPatient(appointment, "Turno confirmado — Clavdia", ({ patient, provider, organization }) =>
    `Hola ${patient.fullName}, tu turno quedó confirmado.\n\n` +
      `Fecha y hora: ${fmtWhen(appointment.start)}\n` +
      `Profesional: ${provider.name}${provider.specialty ? ` (${provider.specialty})` : ""}\n` +
      `${whereLine(organization)}\n` +
      `Motivo: ${appointment.reason}\n\n` +
      `Si necesitás cancelarlo o reprogramarlo, hacelo con la mayor antelación posible.`,
  );
}

export async function notifyAppointmentCancelled(appointment: Appointment): Promise<void> {
  await notifyPatient(appointment, "Turno cancelado — Clavdia", ({ patient, provider, organization }) =>
    `Hola ${patient.fullName}, te confirmamos que cancelamos tu turno.\n\n` +
      `Fecha y hora: ${fmtWhen(appointment.start)}\n` +
      `Profesional: ${provider.name}\n` +
      `${whereLine(organization)}\n\n` +
      `Si fue un error o querés reprogramar, escribinos o sacá un turno nuevo cuando quieras.`,
  );
}

export async function notifyAppointmentReminder(appointment: Appointment): Promise<void> {
  await notifyPatient(appointment, "Recordatorio de turno — Clavdia", ({ patient, provider, organization }) =>
    `Hola ${patient.fullName}, te recordamos tu turno.\n\n` +
      `Fecha y hora: ${fmtWhen(appointment.start)}\n` +
      `Profesional: ${provider.name}${provider.specialty ? ` (${provider.specialty})` : ""}\n` +
      `${whereLine(organization)}\n` +
      `Motivo: ${appointment.reason}\n\n` +
      `Si no podés asistir, cancelalo o reprogramalo para liberar el horario.`,
  );
}
