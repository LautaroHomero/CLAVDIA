import { actorFromRequest } from "@/lib/auth/actor";
import {
  getOrganization,
  getPatient,
  getProvider,
  getProviderSettings,
  getSlot,
  joinPatientOrg,
  patientInOrg,
} from "@/lib/db/repo";
import { bookAppointment } from "@/lib/domain/scheduling";
import type { Actor } from "@/lib/domain/types";

interface BookBody {
  slotId?: string;
  reason?: string;
  patientId?: string;
  organizationId?: string;
}

/** Resolve which of the patient's organizations a booking targets. */
function resolvePatientOrgId(actor: Actor, requested?: string): string | { error: string } {
  const orgs = actor.orgs ?? [];
  if (orgs.length === 0) return { error: "No estás registrado en ningún consultorio." };
  if (requested) {
    const hit = orgs.find((o) => o.id === requested);
    return hit ? hit.id : { error: "No estás registrado en ese consultorio." };
  }
  return orgs.length === 1 ? orgs[0].id : { error: "Indicá en qué consultorio querés el turno." };
}

/** Manual booking (patient self-service, or reception / doctor for a patient). */
export async function POST(req: Request) {
  const actor = actorFromRequest(req);
  if (!actor) return Response.json({ ok: false, error: "No autenticado." }, { status: 401 });

  const body = (await req.json()) as BookBody;
  const slotId = body.slotId?.trim();
  const reason = body.reason?.trim() || "Consulta";
  if (!slotId) return Response.json({ ok: false, error: "Falta el horario." }, { status: 400 });

  const slot = getSlot(slotId);
  if (!slot) return Response.json({ ok: false, error: "Ese horario no existe." }, { status: 404 });
  if (slot.taken) return Response.json({ ok: false, error: "Ese horario ya fue tomado." }, { status: 409 });

  let organizationId: string;
  let patientId: string;

  if (actor.role === "paciente") {
    if (!actor.patientId) {
      return Response.json({ ok: false, error: "Ficha no encontrada." }, { status: 400 });
    }
    const resolved = resolvePatientOrgId(actor, body.organizationId);
    if (typeof resolved !== "string") {
      return Response.json({ ok: false, error: resolved.error }, { status: 400 });
    }
    organizationId = resolved;
    patientId = actor.patientId;

    if (getProviderSettings(slot.providerId).whoCanChange === "staff_only") {
      return Response.json(
        { ok: false, error: "Este profesional no toma turnos online. Escribile a recepción o usá el asistente." },
        { status: 403 },
      );
    }
    if (!patientInOrg(patientId, organizationId)) joinPatientOrg(patientId, organizationId);
  } else {
    organizationId = actor.activeOrg?.id ?? "";
    if (!organizationId) {
      return Response.json({ ok: false, error: "Sin organización activa." }, { status: 400 });
    }
    patientId = body.patientId?.trim() ?? "";
    if (!patientId || !getPatient(patientId)) {
      return Response.json({ ok: false, error: "Indicá un paciente válido." }, { status: 400 });
    }
    if (!patientInOrg(patientId, organizationId)) {
      return Response.json(
        { ok: false, error: "Ese paciente no está registrado en este consultorio." },
        { status: 400 },
      );
    }
    if (
      actor.role === "medico" &&
      actor.activeOrg?.providerId &&
      slot.providerId !== actor.activeOrg.providerId
    ) {
      return Response.json({ ok: false, error: "Ese horario no es de tu agenda." }, { status: 403 });
    }
  }

  const res = bookAppointment({ organizationId, patientId, slotId, reason, createdVia: "front-desk" });
  if (!res.ok) return Response.json(res, { status: 409 });

  return Response.json({
    ok: true,
    appointment: {
      id: res.appointment.id,
      start: res.appointment.start,
      reason: res.appointment.reason,
      provider: getProvider(res.appointment.providerId)?.name,
      organization: getOrganization(organizationId)?.name,
    },
    price: res.price,
  });
}
