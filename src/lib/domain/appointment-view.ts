/**
 * Presentation helpers shared by the read endpoints (`/api/system`,
 * `/api/calendar-grid`): "what can this actor do to this appointment by hand"
 * and a flattened view of a pending change request.
 */
import {
  getAppointment,
  getPatient,
  getProvider,
  getProviderSettings,
} from "@/lib/db/repo";
import type { Actor, Appointment, AppointmentChangeRequest } from "@/lib/domain/types";

export interface ManageFlags {
  canCancel: boolean;
  canReschedule: boolean;
  needsApproval: boolean;
  blockedReason: string | null;
}

/** What the caller may do to `appt` from the manual UI. */
export function manageFlags(actor: Actor, appt: Appointment): ManageFlags {
  const off: ManageFlags = { canCancel: false, canReschedule: false, needsApproval: false, blockedReason: null };
  if (appt.status !== "scheduled") return off;
  if (Date.parse(appt.start) <= Date.now()) return off;

  const settings = getProviderSettings(appt.providerId);

  if (actor.role === "paciente") {
    if (settings.whoCanChange === "staff_only") {
      return { ...off, blockedReason: "El profesional gestiona estos cambios desde recepción." };
    }
    const hoursUntil = (Date.parse(appt.start) - Date.now()) / 3_600_000;
    const needsApproval = hoursUntil < 24 && settings.lateChangePolicy === "needs_approval";
    return { canCancel: true, canReschedule: true, needsApproval, blockedReason: null };
  }

  if (actor.role === "medico") {
    const mine = appt.providerId === actor.activeOrg?.providerId;
    return { canCancel: mine, canReschedule: mine, needsApproval: false, blockedReason: null };
  }

  // recepción
  return { canCancel: true, canReschedule: true, needsApproval: false, blockedReason: null };
}

export function changeRequestView(r: AppointmentChangeRequest) {
  const appt = getAppointment(r.appointmentId);
  return {
    id: r.id,
    kind: r.kind,
    patientName: getPatient(r.patientId)?.fullName ?? r.patientId,
    providerName: getProvider(r.providerId)?.name ?? r.providerId,
    reason: r.reason,
    requestedBy: r.requestedBy,
    createdAt: r.createdAt,
    currentStart: appt?.start ?? null,
    appointmentStatus: appt?.status ?? null,
  };
}
