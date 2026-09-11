import { actorFromRequest } from "@/lib/auth/actor";
import {
  createChangeRequest,
  getAppointment,
  getProviderSettings,
  getSlot,
} from "@/lib/db/repo";
import { cancelAppointment, rescheduleAppointment } from "@/lib/domain/scheduling";
import type { Actor, Appointment } from "@/lib/domain/types";

type Access = { ok: true } | { ok: false; status: number; error: string };

/** May this actor manage this appointment by hand? */
async function checkAccess(actor: Actor, appt: Appointment): Promise<Access> {
  if (actor.role === "paciente") {
    if (appt.patientId !== actor.patientId) {
      return { ok: false, status: 403, error: "Ese turno no pertenece a tu ficha." };
    }
    const settings = await getProviderSettings(appt.providerId);
    if (settings.whoCanChange === "staff_only") {
      return {
        ok: false,
        status: 403,
        error: "Este profesional gestiona sus cambios desde recepción. Escribiles o usá el asistente.",
      };
    }
    return { ok: true };
  }
  if (appt.organizationId !== actor.activeOrg?.id) {
    return { ok: false, status: 403, error: "Ese turno es de otro consultorio." };
  }
  if (
    actor.role === "medico" &&
    actor.activeOrg?.providerId &&
    appt.providerId !== actor.activeOrg.providerId
  ) {
    return { ok: false, status: 403, error: "Ese turno no es de tu agenda." };
  }
  return { ok: true };
}

/** True when a patient's late change must be signed off by the professional. */
async function needsSignOff(actor: Actor, appt: Appointment): Promise<boolean> {
  if (actor.role !== "paciente") return false;
  const hoursUntil = (Date.parse(appt.start) - Date.now()) / 3_600_000;
  const settings = await getProviderSettings(appt.providerId);
  return hoursUntil < 24 && settings.lateChangePolicy === "needs_approval";
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const actor = await actorFromRequest(req);
  if (!actor) return Response.json({ ok: false, error: "No autenticado." }, { status: 401 });

  const { id } = await ctx.params;
  const appt = await getAppointment(id);
  if (!appt) return Response.json({ ok: false, error: "El turno no existe." }, { status: 404 });

  const access = await checkAccess(actor, appt);
  if (!access.ok) return Response.json({ ok: false, error: access.error }, { status: access.status });
  if (appt.status !== "scheduled") {
    return Response.json({ ok: false, error: `El turno está ${appt.status}.` }, { status: 409 });
  }

  const { newSlotId } = (await req.json()) as { newSlotId?: string };
  const slotId = newSlotId?.trim();
  if (!slotId) return Response.json({ ok: false, error: "Falta el nuevo horario." }, { status: 400 });
  const slot = await getSlot(slotId);
  if (!slot || slot.taken) {
    return Response.json({ ok: false, error: "Ese horario no está disponible." }, { status: 409 });
  }
  if (slot.providerId !== appt.providerId) {
    return Response.json(
      { ok: false, error: "El nuevo horario tiene que ser del mismo profesional." },
      { status: 400 },
    );
  }

  if (await needsSignOff(actor, appt)) {
    await createChangeRequest({
      organizationId: appt.organizationId,
      appointmentId: appt.id,
      providerId: appt.providerId,
      patientId: appt.patientId,
      kind: "reschedule",
      newSlotId: slotId,
      reason: appt.reason,
      requestedBy: actor.name,
    });
    return Response.json({
      ok: true,
      pending: true,
      message: "Tu pedido de cambio quedó en revisión del profesional.",
    });
  }

  const res = await rescheduleAppointment(appt.id, slotId);
  if (!res.ok) return Response.json(res, { status: 409 });
  return Response.json({
    ok: true,
    pending: false,
    appointmentId: res.appointment.id,
    start: res.appointment.start,
    notices: res.notices,
  });
}

export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const actor = await actorFromRequest(req);
  if (!actor) return Response.json({ ok: false, error: "No autenticado." }, { status: 401 });

  const { id } = await ctx.params;
  const appt = await getAppointment(id);
  if (!appt) return Response.json({ ok: false, error: "El turno no existe." }, { status: 404 });

  const access = await checkAccess(actor, appt);
  if (!access.ok) return Response.json({ ok: false, error: access.error }, { status: access.status });
  if (appt.status !== "scheduled") {
    return Response.json({ ok: false, error: `El turno está ${appt.status}.` }, { status: 409 });
  }

  if (await needsSignOff(actor, appt)) {
    await createChangeRequest({
      organizationId: appt.organizationId,
      appointmentId: appt.id,
      providerId: appt.providerId,
      patientId: appt.patientId,
      kind: "cancel",
      reason: appt.reason,
      requestedBy: actor.name,
    });
    return Response.json({
      ok: true,
      pending: true,
      message: "Tu pedido de cancelación quedó en revisión del profesional.",
    });
  }

  const res = await cancelAppointment(appt.id);
  if (!res.ok) return Response.json(res, { status: 409 });
  return Response.json({ ok: true, pending: false, notices: res.notices });
}
