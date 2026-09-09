import { actorFromRequest } from "@/lib/auth/actor";
import { DEMO_TODAY } from "@/lib/domain/clock";
import {
  getAppointmentsForPatient,
  getOrganization,
  getPatient,
  getProvider,
  isBirthday,
  listAppointments,
  listProviders,
} from "@/lib/db/repo";

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

/**
 * Data for the plain "Sistema" view (no agent). Staff get the org-wide calendar
 * plus the consultorio + professionals; patients get their calendar + their
 * ficha.
 */
export async function GET(req: Request) {
  const actor = actorFromRequest(req);
  if (!actor) return Response.json({ error: "No autenticado." }, { status: 401 });

  if (actor.role === "paciente" && actor.patientId) {
    const p = getPatient(actor.patientId);
    if (!p) return Response.json({ error: "Ficha no encontrada." }, { status: 404 });

    const orgIds = actor.orgs.map((o) => o.id);
    const multiOrg = actor.orgs.length > 1;
    const rows = getAppointmentsForPatient(actor.patientId, orgIds)
      .filter((a) => a.start.slice(0, 10) >= DEMO_TODAY && a.status !== "cancelled")
      .map((a) => {
        const prov = getProvider(a.providerId);
        const orgName = getOrganization(a.organizationId)?.name ?? "";
        return {
          date: a.start.slice(0, 10),
          item: {
            time: a.start.slice(11, 16),
            who: prov ? `${prov.name} · ${prov.specialty}` : a.providerId,
            reason: multiOrg ? `${a.reason} · ${orgName}` : a.reason,
            status: a.status,
          },
        };
      });

    return Response.json({
      role: "paciente",
      profile: {
        fullName: p.fullName,
        dni: p.dni,
        dateOfBirth: p.dateOfBirth,
        coverage: p.coverage,
        phone: p.phone,
        email: p.email,
        allergies: p.allergies,
        activeConditions: p.activeConditions,
        medications: p.medications.map((m) => ({ name: m.name, dose: m.dose, chronic: m.chronic })),
        orgs: actor.orgs.map((o) => o.name),
      },
      calendar: { title: "Mis turnos", days: groupByDate(rows) },
    });
  }

  // staff (medico / recepcion) — scoped to the active organization
  const orgId = actor.activeOrg?.id;
  const org = orgId ? getOrganization(orgId) : undefined;
  const providers = orgId ? listProviders(orgId) : [];
  const rows = (orgId ? listAppointments(orgId) : [])
    .filter((a) => a.start.slice(0, 10) >= DEMO_TODAY)
    .map((a) => ({
      date: a.start.slice(0, 10),
      item: {
        time: a.start.slice(11, 16),
        who: getPatient(a.patientId)?.fullName ?? a.patientId,
        provider: getProvider(a.providerId)?.name ?? a.providerId,
        reason: a.reason,
        status: a.status,
        birthday: isBirthday(a.patientId, a.start.slice(0, 10)),
      },
    }));

  return Response.json({
    role: "staff",
    organization: org
      ? { name: org.name, address: org.address, hours: org.hours, phone: org.phone }
      : null,
    me: { name: actor.name, role: actor.role, specialty: actor.activeOrg?.specialty ?? null },
    providers: providers.map((p) => ({ name: p.name, specialty: p.specialty, roomLabel: p.roomLabel })),
    calendar: { title: org ? `Agenda · ${org.name}` : "Agenda", days: groupByDate(rows) },
  });
}
