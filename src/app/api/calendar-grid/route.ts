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
async function scopeProvider(
  actor: Actor,
  requested: string | null,
): Promise<string | undefined | { error: string }> {
  const orgId = actor.activeOrg?.id;
  if (!orgId) return { error: "Sin organización activa." };
  if (actor.role === "medico") return actor.activeOrg?.providerId;
  if (!requested || requested === "all") return undefined;
  const providers = await listProviders(orgId);
  return providers.some((p) => p.id === requested)
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
  const actor = await actorFromRequest(req);
  if (!actor) return Response.json({ error: "No autenticado." }, { status: 401 });
  if (actor.role === "paciente") {
    return Response.json({ error: "Solo personal del consultorio." }, { status: 403 });
  }
  const orgId = actor.activeOrg?.id;
  if (!orgId) return Response.json({ error: "Sin organización activa." }, { status: 400 });

  const url = new URL(req.url);
  const providerId = await scopeProvider(actor, url.searchParams.get("providerId"));
  if (providerId && typeof providerId === "object") {
    return Response.json({ error: providerId.error }, { status: 400 });
  }

  const date = url.searchParams.get("date");
  if (date) {
    const [apptRows, slotRows] = await Promise.all([
      listAppointments(orgId, { providerId, date }),
      listOpenSlots(orgId, { providerId, date }),
    ]);
    const appts = await Promise.all(
      apptRows.map(async (a) => {
        const [patient, provider] = await Promise.all([getPatient(a.patientId), getProvider(a.providerId)]);
        return {
          id: a.id,
          time: a.start.slice(11, 16),
          startIso: a.start,
          patientName: patient?.fullName ?? a.patientId,
          reason: a.reason,
          status: a.status,
          providerId: a.providerId,
          providerName: provider?.name ?? a.providerId,
          manage: await manageFlags(actor, a),
        };
      }),
    );
    const freeSlots = await Promise.all(
      slotRows.map(async (s) => ({
        slotId: s.id,
        time: s.start.slice(11, 16),
        startIso: s.start,
        providerId: s.providerId,
        providerName: (await getProvider(s.providerId))?.name ?? s.providerId,
      })),
    );
    return Response.json({ date, appointments: appts, freeSlots });
  }

  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  if (!from || !to) {
    return Response.json({ error: "Indicá 'date', o 'from' y 'to'." }, { status: 400 });
  }
  const days = await Promise.all(
    eachDay(from, to).map(async (d) => {
      const [appts, free] = await Promise.all([
        listAppointments(orgId, { providerId, date: d }),
        listOpenSlots(orgId, { providerId, date: d }),
      ]);
      return { date: d, appts: appts.length, free: free.length };
    }),
  );
  const providers =
    actor.role === "recepcion"
      ? (await listProviders(orgId)).map((p) => ({ id: p.id, name: p.name, specialty: p.specialty }))
      : [];
  return Response.json({ from, to, providerId: providerId ?? null, providers, days });
}
