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
export async function refreshWaitingNotices(
  orgId: string,
  providerId: string,
): Promise<WaitingNotice[]> {
  const agenda = await providerAgenda(providerId, DEMO_TODAY);
  const out: WaitingNotice[] = [];
  for (const e of [...(agenda.next ? [agenda.next] : []), ...agenda.upcoming]) {
    const earlier = await earlierOpeningToday(providerId, DEMO_TODAY, e.estimated);
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
      await replacePatientNotice(orgId, e.appointmentId, e.patientId, DEMO_TODAY, msg);
      out.push({ patient: e.patientName, message: msg });
    } else {
      await clearNoticesForAppointment(e.appointmentId);
    }
  }
  return out;
}

export async function bookAppointment(args: {
  organizationId: string;
  patientId: string;
  slotId: string;
  reason: string;
  createdVia?: Appointment["createdVia"];
}): Promise<SchedulingResult<{ appointment: Appointment; price: number }>> {
  const slot = await getSlot(args.slotId);
  if (!slot) return { ok: false, error: `El horario ${args.slotId} no existe.` };
  if (slot.taken) return { ok: false, error: `El horario ${args.slotId} ya fue tomado.` };
  try {
    const appointment = await bookSlot(args);
    const price = await priceForReason(appointment.providerId, args.reason);
    await setAppointmentPrice(appointment.id, price);
    return { ok: true, appointment, price };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export async function cancelAppointment(
  appointmentId: string,
): Promise<SchedulingResult<{ appointment: Appointment; notices: WaitingNotice[] }>> {
  const existing = await getAppointment(appointmentId);
  if (!existing) return { ok: false, error: `El turno ${appointmentId} no existe.` };
  if (existing.status !== "scheduled") {
    return { ok: false, error: `El turno ${appointmentId} está ${existing.status}.` };
  }
  const appointment = await cancelAppointmentById(appointmentId);
  await clearNoticesForAppointment(appointmentId);
  const notices = existing.start.startsWith(DEMO_TODAY)
    ? await refreshWaitingNotices(existing.organizationId, existing.providerId)
    : [];
  return { ok: true, appointment, notices };
}

export async function rescheduleAppointment(
  appointmentId: string,
  newSlotId: string,
): Promise<
  SchedulingResult<{ appointment: Appointment; previousAppointmentId: string; notices: WaitingNotice[] }>
> {
  const existing = await getAppointment(appointmentId);
  if (!existing) return { ok: false, error: `El turno ${appointmentId} no existe.` };
  if (existing.status !== "scheduled") {
    return { ok: false, error: `El turno ${appointmentId} está ${existing.status}.` };
  }
  const slot = await getSlot(newSlotId);
  if (!slot || slot.taken) {
    return { ok: false, error: `El nuevo horario ${newSlotId} no está disponible.` };
  }
  await cancelAppointmentById(appointmentId);
  await clearNoticesForAppointment(appointmentId);
  const appointment = await bookSlot({
    organizationId: existing.organizationId,
    patientId: existing.patientId,
    slotId: newSlotId,
    reason: existing.reason,
    createdVia: existing.createdVia,
  });
  await setAppointmentPrice(
    appointment.id,
    existing.price || (await priceForReason(appointment.providerId, existing.reason)),
  );
  const notices =
    existing.start.startsWith(DEMO_TODAY) || appointment.start.startsWith(DEMO_TODAY)
      ? await refreshWaitingNotices(existing.organizationId, existing.providerId)
      : [];
  return { ok: true, appointment, previousAppointmentId: appointmentId, notices };
}
