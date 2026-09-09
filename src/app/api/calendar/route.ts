import { actorFromRequest } from "@/lib/auth/actor";
import { DEMO_TODAY } from "@/lib/domain/clock";
import {
  freeSlotCount,
  getAppointmentsForPatient,
  getOrganization,
  getPatient,
  getProvider,
  isBirthday,
  providerAgenda,
  providerAppointments,
} from "@/lib/db/repo";
import type { Appointment } from "@/lib/domain/types";

function dayLabel(date: string): string {
  const d = new Date(`${date}T12:00:00`);
  const s = d.toLocaleDateString("es-AR", { weekday: "long", day: "2-digit", month: "2-digit" });
  return date === DEMO_TODAY ? `Hoy · ${s}` : s;
}

function groupByDate<T>(rows: { date: string; item: T }[]): { date: string; label: string; items: T[] }[] {
  const map = new Map<string, T[]>();
  for (const r of rows) {
    if (!map.has(r.date)) map.set(r.date, []);
    map.get(r.date)!.push(r.item);
  }
  return [...map.entries()].map(([date, items]) => ({ date, label: dayLabel(date), items }));
}

/** Mini schedule. Professional: their agenda in the active org. Patient: their turns across all orgs. */
export async function GET(req: Request) {
  const actor = actorFromRequest(req);
  if (!actor) return Response.json({ error: "No autenticado." }, { status: 401 });

  const upcoming = (a: Appointment) => a.start.slice(0, 10) >= DEMO_TODAY && a.status !== "cancelled";

  if (actor.role === "medico" && actor.activeOrg?.providerId) {
    const pid = actor.activeOrg.providerId;
    const today = providerAgenda(pid, DEMO_TODAY);
    const estimatedFor = (id: string) =>
      [today.inAttention, today.next, ...today.upcoming].find((e) => e?.appointmentId === id)?.estimated;

    const rows = providerAppointments(pid)
      .filter(upcoming)
      .map((a) => ({
        date: a.start.slice(0, 10),
        item: {
          time: a.start.slice(11, 16),
          who: getPatient(a.patientId)?.fullName ?? a.patientId,
          reason: a.reason,
          status: a.status,
          birthday: isBirthday(a.patientId, a.start.slice(0, 10)),
          estimated: a.start.slice(0, 10) === DEMO_TODAY ? estimatedFor(a.id) : undefined,
        },
      }));

    const days = groupByDate(rows).map((d) => ({ ...d, free: freeSlotCount(pid, d.date) }));
    return Response.json({ role: "medico", title: `Mi agenda · ${actor.activeOrg.name}`, days });
  }

  if (actor.role === "paciente" && actor.patientId) {
    const orgIds = actor.orgs.map((o) => o.id);
    const multiOrg = actor.orgs.length > 1;
    const rows = getAppointmentsForPatient(actor.patientId, orgIds)
      .filter(upcoming)
      .map((a) => {
        const prov = getProvider(a.providerId);
        let estimated: string | undefined;
        if (a.start.slice(0, 10) === DEMO_TODAY) {
          const ag = providerAgenda(a.providerId, DEMO_TODAY);
          estimated = [ag.inAttention, ag.next, ...ag.upcoming].find((e) => e?.appointmentId === a.id)?.estimated;
        }
        const orgName = getOrganization(a.organizationId)?.name ?? "";
        return {
          date: a.start.slice(0, 10),
          item: {
            time: a.start.slice(11, 16),
            who: prov ? `${prov.name} · ${prov.specialty}` : a.providerId,
            reason: multiOrg ? `${a.reason} · ${orgName}` : a.reason,
            status: a.status,
            birthday: false,
            estimated,
          },
        };
      });
    return Response.json({ role: "paciente", title: "Mis turnos", days: groupByDate(rows) });
  }

  return Response.json({ role: actor.role, days: [] });
}
