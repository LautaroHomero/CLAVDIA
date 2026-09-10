/**
 * Shared appointment mutations — booking, cancelling and rescheduling — used by
 * BOTH the agent tools (`src/workflows/secretary/tools.ts`) and the manual REST
 * endpoints (`src/app/api/appointments/**`). Callers are responsible for
 * authorization (role / org / ownership); this module only touches the data and
 * keeps the live-agenda notices in sync.
 */
import { DEMO_TODAY } from "@/lib/domain/clock";
import {
  bookSlot,
  cancelAppointmentById,
  clearNoticesForAppointment,
  earlierOpeningToday,
  getAppointment,
  getSlot,
  priceForReason,
  providerAgenda,
  replacePatientNotice,
  setAppointmentPrice,
} from "@/lib/db/repo";
import type { Appointment } from "@/lib/domain/types";

export type SchedulingResult<T> = ({ ok: true } & T) | { ok: false; error: string };

export interface WaitingNotice {
  patient: string;
  message: string;
}

const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

/**
 * Recompute the "your turn may run late / a slot opened earlier" notices for
 * everyone still waiting on a provider today. Moved here from tools.ts so the
 * manual flow refreshes them exactly like the agent flow does.
 */
export function refreshWaitingNotices(orgId: string, providerId: string): WaitingNotice[] {
  const agenda = providerAgenda(providerId, DEMO_TODAY);
  const out: WaitingNotice[] = [];
  for (const e of [...(agenda.next ? [agenda.next] : []), ...agenda.upcoming]) {
    const earlier = earlierOpeningToday(providerId, DEMO_TODAY, e.estimated);
    let msg: string | null = null;
    if (e.delayMinutes >= 10) {
      msg =
        `Se demoró un turno anterior. Tu cita de las ${e.scheduled} se estima ahora ~${e.estimated} ` +
        `(la agenda va +${e.delayMinutes} min). Si te queda mejor, podés venir más tarde` +
        (earlier ? `, o adelantarte: hay lugar ${earlier.time}.` : ".");
    } else if (earlier && toMin(e.scheduled) - toMin(earlier.time) >= 15) {
      msg =
        `Se liberó un turno más temprano con ${agenda.providerName}: hay lugar ${earlier.time} ` +
        `(el tuyo es ${e.scheduled}). Si te sirve, podés adelantarte.`;
    }
    if (msg) {
      replacePatientNotice(orgId, e.appointmentId, e.patientId, DEMO_TODAY, msg);
      out.push({ patient: e.patientName, message: msg });
    } else {
      clearNoticesForAppointment(e.appointmentId);
    }
  }
  return out;
}

export function bookAppointment(args: {
  organizationId: string;
  patientId: string;
  slotId: string;
  reason: string;
  createdVia?: Appointment["createdVia"];
}): SchedulingResult<{ appointment: Appointment; price: number }> {
  const slot = getSlot(args.slotId);
  if (!slot) return { ok: false, error: `El horario ${args.slotId} no existe.` };
  if (slot.taken) return { ok: false, error: `El horario ${args.slotId} ya fue tomado.` };
  try {
    const appointment = bookSlot(args);
    const price = priceForReason(appointment.providerId, args.reason);
    setAppointmentPrice(appointment.id, price);
    return { ok: true, appointment, price };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export function cancelAppointment(
  appointmentId: string,
): SchedulingResult<{ appointment: Appointment; notices: WaitingNotice[] }> {
  const existing = getAppointment(appointmentId);
  if (!existing) return { ok: false, error: `El turno ${appointmentId} no existe.` };
  if (existing.status !== "scheduled") {
    return { ok: false, error: `El turno ${appointmentId} está ${existing.status}.` };
  }
  const appointment = cancelAppointmentById(appointmentId);
  clearNoticesForAppointment(appointmentId);
  const notices = existing.start.startsWith(DEMO_TODAY)
    ? refreshWaitingNotices(existing.organizationId, existing.providerId)
    : [];
  return { ok: true, appointment, notices };
}

export function rescheduleAppointment(
  appointmentId: string,
  newSlotId: string,
): SchedulingResult<{ appointment: Appointment; previousAppointmentId: string; notices: WaitingNotice[] }> {
  const existing = getAppointment(appointmentId);
  if (!existing) return { ok: false, error: `El turno ${appointmentId} no existe.` };
  if (existing.status !== "scheduled") {
    return { ok: false, error: `El turno ${appointmentId} está ${existing.status}.` };
  }
  const slot = getSlot(newSlotId);
  if (!slot || slot.taken) {
    return { ok: false, error: `El nuevo horario ${newSlotId} no está disponible.` };
  }
  cancelAppointmentById(appointmentId);
  clearNoticesForAppointment(appointmentId);
  const appointment = bookSlot({
    organizationId: existing.organizationId,
    patientId: existing.patientId,
    slotId: newSlotId,
    reason: existing.reason,
    createdVia: existing.createdVia,
  });
  setAppointmentPrice(
    appointment.id,
    existing.price || priceForReason(appointment.providerId, existing.reason),
  );
  const notices =
    existing.start.startsWith(DEMO_TODAY) || appointment.start.startsWith(DEMO_TODAY)
      ? refreshWaitingNotices(existing.organizationId, existing.providerId)
      : [];
  return { ok: true, appointment, previousAppointmentId: appointmentId, notices };
}
