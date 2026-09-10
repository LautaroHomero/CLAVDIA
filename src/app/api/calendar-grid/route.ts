import { actorFromRequest } from "@/lib/auth/actor";
import {
  getPatient,
  getProvider,
  listAppointments,
  listOpenSlots,
  listProviders,
} from "@/lib/db/repo";
import { manageFlags } from "@/lib/domain/appointment-view";
import type { Actor } from "@/lib/domain/types";

/** Which provider(s) the request is scoped to. médico is locked to their own. */
function scopeProvider(actor: Actor, requested: string | null): string | undefined | { error: string } {
  const orgId = actor.activeOrg?.id;
  if (!orgId) return { error: "Sin organización activa." };
  if (actor.role === "medico") return actor.activeOrg?.providerId;
  if (!requested || requested === "all") return undefined;
  return listProviders(orgId).some((p) => p.id === requested)
    ? requested
    : { error: "Ese profesional no es de este consultorio." };
}

function eachDay(from: string, to: string): string[] {
  const out: string[] = [];
  const d = new Date(`${from}T12:00:00`);
  const end = new Date(`${to}T12:00:00`);
  while (d <= end) {
    out.push(d.toISOString().slice(0, 10));
    d.setDate(d.getDate() + 1);
  }
  return out;
}

export async function GET(req: Request) {
  const actor = actorFromRequest(req);
  if (!actor) return Response.json({ error: "No autenticado." }, { status: 401 });
  if (actor.role === "paciente") {
    return Response.json({ error: "Solo personal del consultorio." }, { status: 403 });
  }
  const orgId = actor.activeOrg?.id;
  if (!orgId) return Response.json({ error: "Sin organización activa." }, { status: 400 });

  const url = new URL(req.url);
  const providerId = scopeProvider(actor, url.searchParams.get("providerId"));
  if (providerId && typeof providerId === "object") {
    return Response.json({ error: providerId.error }, { status: 400 });
  }

  const date = url.searchParams.get("date");
  if (date) {
    const appts = listAppointments(orgId, { providerId, date }).map((a) => ({
      id: a.id,
      time: a.start.slice(11, 16),
      startIso: a.start,
      patientName: getPatient(a.patientId)?.fullName ?? a.patientId,
      reason: a.reason,
      status: a.status,
      providerId: a.providerId,
      providerName: getProvider(a.providerId)?.name ?? a.providerId,
      manage: manageFlags(actor, a),
    }));
    const freeSlots = listOpenSlots(orgId, { providerId, date }).map((s) => ({
      slotId: s.id,
      time: s.start.slice(11, 16),
      startIso: s.start,
      providerId: s.providerId,
      providerName: getProvider(s.providerId)?.name ?? s.providerId,
    }));
    return Response.json({ date, appointments: appts, freeSlots });
  }

  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  if (!from || !to) {
    return Response.json({ error: "Indicá 'date', o 'from' y 'to'." }, { status: 400 });
  }
  const days = eachDay(from, to).map((d) => ({
    date: d,
    appts: listAppointments(orgId, { providerId, date: d }).length,
    free: listOpenSlots(orgId, { providerId, date: d }).length,
  }));
  return Response.json({
    from,
    to,
    providerId: providerId ?? null,
    providers:
      actor.role === "recepcion"
        ? listProviders(orgId).map((p) => ({ id: p.id, name: p.name, specialty: p.specialty }))
        : [],
    days,
  });
}
