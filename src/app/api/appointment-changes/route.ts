import { actorFromRequest } from "@/lib/auth/actor";
import {
  decideChangeRequest,
  getAppointment,
  getChangeRequest,
  getPatient,
  getProvider,
  getSlot,
  listChangeRequests,
} from "@/lib/db/repo";
import { cancelAppointment, rescheduleAppointment } from "@/lib/domain/scheduling";
import type { AppointmentChangeRequest } from "@/lib/domain/types";

function view(r: AppointmentChangeRequest) {
  const appt = getAppointment(r.appointmentId);
  return {
    id: r.id,
    kind: r.kind,
    status: r.status,
    patientName: getPatient(r.patientId)?.fullName ?? r.patientId,
    providerName: getProvider(r.providerId)?.name ?? r.providerId,
    reason: r.reason,
    requestedBy: r.requestedBy,
    createdAt: r.createdAt,
    currentStart: appt?.start ?? null,
    appointmentStatus: appt?.status ?? null,
    newStart: r.newSlotId ? (getSlot(r.newSlotId)?.start ?? null) : null,
  };
}

/** Pending manual-change requests, scoped to the caller. */
export async function GET(req: Request) {
  const actor = actorFromRequest(req);
  if (!actor) return Response.json({ error: "No autenticado." }, { status: 401 });

  let list: AppointmentChangeRequest[];
  if (actor.role === "paciente") {
    list = actor.patientId
      ? listChangeRequests({ patientId: actor.patientId, status: "pending" })
      : [];
  } else if (actor.role === "medico" && actor.activeOrg?.providerId) {
    list = listChangeRequests({ providerId: actor.activeOrg.providerId, status: "pending" });
  } else {
    list = actor.activeOrg?.id
      ? listChangeRequests({ organizationId: actor.activeOrg.id, status: "pending" })
      : [];
  }
  return Response.json({ role: actor.role, requests: list.map(view) });
}

/** Approve or reject a pending change request (staff only) — approval executes it. */
export async function POST(req: Request) {
  const actor = actorFromRequest(req);
  if (!actor) return Response.json({ ok: false, error: "No autenticado." }, { status: 401 });
  if (actor.role === "paciente") {
    return Response.json({ ok: false, error: "Solo el profesional o recepción deciden." }, { status: 403 });
  }

  const { id, approved, note } = (await req.json()) as { id?: string; approved?: boolean; note?: string };
  if (!id) return Response.json({ ok: false, error: "Falta 'id'." }, { status: 400 });

  const cr = getChangeRequest(id);
  if (!cr || cr.status !== "pending") {
    return Response.json({ ok: false, error: "Ese pedido ya no está pendiente." }, { status: 409 });
  }
  if (actor.role === "medico") {
    if (cr.providerId !== actor.activeOrg?.providerId) {
      return Response.json({ ok: false, error: "Ese pedido no es de tu agenda." }, { status: 403 });
    }
  } else if (cr.organizationId !== actor.activeOrg?.id) {
    return Response.json({ ok: false, error: "Ese pedido es de otro consultorio." }, { status: 403 });
  }

  const decidedBy = `${actor.name} (${actor.role})`;

  if (!approved) {
    decideChangeRequest(id, { status: "rejected", decidedBy });
    return Response.json({ ok: true, status: "rejected" });
  }

  const res =
    cr.kind === "cancel"
      ? cancelAppointment(cr.appointmentId)
      : rescheduleAppointment(cr.appointmentId, cr.newSlotId ?? "");
  if (!res.ok) {
    // Leave it pending so staff can retry or reject explicitly.
    return Response.json({ ok: false, error: res.error }, { status: 409 });
  }
  decideChangeRequest(id, { status: "approved", decidedBy });
  return Response.json({
    ok: true,
    status: "approved",
    kind: cr.kind,
    note: note?.trim() || undefined,
    notices: res.notices,
  });
}
