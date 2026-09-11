import { actorFromRequest } from "@/lib/auth/actor";
import { DEMO_TODAY } from "@/lib/domain/clock";
import {
  getAppointmentsForPatient,
  getOrganization,
  getPatient,
  getProvider,
  getProviderSettings,
  isBirthday,
  listAppointments,
  listChangeRequests,
  listProviders,
} from "@/lib/db/repo";
import { changeRequestView, manageFlags } from "@/lib/domain/appointment-view";

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
 * ficha. Every calendar item now carries the ids + `manage` flags the manual
 * appointment controls need.
 */
export async function GET(req: Request) {
  const actor = await actorFromRequest(req);
  if (!actor) return Response.json({ error: "No autenticado." }, { status: 401 });

  if (actor.role === "paciente" && actor.patientId) {
    const p = await getPatient(actor.patientId);
    if (!p) return Response.json({ error: "Ficha no encontrada." }, { status: 404 });

    const orgIds = actor.orgs.map((o) => o.id);
    const multiOrg = actor.orgs.length > 1;
    const appts = (await getAppointmentsForPatient(actor.patientId, orgIds)).filter(
      (a) => a.start.slice(0, 10) >= DEMO_TODAY && a.status !== "cancelled",
    );
    const rows = await Promise.all(
      appts.map(async (a) => {
        const prov = await getProvider(a.providerId);
        const org = await getOrganization(a.organizationId);
        const orgName = org?.name ?? "";
        return {
          date: a.start.slice(0, 10),
          item: {
            time: a.start.slice(11, 16),
            who: prov ? `${prov.name} · ${prov.specialty}` : a.providerId,
            reason: multiOrg ? `${a.reason} · ${orgName}` : a.reason,
            status: a.status,
            appointmentId: a.id,
            providerId: a.providerId,
            organizationId: a.organizationId,
            startIso: a.start,
            manage: await manageFlags(actor, a),
          },
        };
      }),
    );

    const changeRequests = await Promise.all(
      (await listChangeRequests({ patientId: actor.patientId, status: "pending" })).map(changeRequestView),
    );

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
      orgs: actor.orgs.map((o) => ({ id: o.id, name: o.name })),
      calendar: { title: "Mis turnos", days: groupByDate(rows) },
      changeRequests,
    });
  }

  // staff (medico / recepcion) — scoped to the active organization
  const orgId = actor.activeOrg?.id;
  const org = orgId ? await getOrganization(orgId) : undefined;
  const providers = orgId ? await listProviders(orgId) : [];
  const staffAppts = (orgId ? await listAppointments(orgId) : []).filter(
    (a) => a.start.slice(0, 10) >= DEMO_TODAY,
  );
  const rows = await Promise.all(
    staffAppts.map(async (a) => {
      const [patient, provider, birthday, manage] = await Promise.all([
        getPatient(a.patientId),
        getProvider(a.providerId),
        isBirthday(a.patientId, a.start.slice(0, 10)),
        manageFlags(actor, a),
      ]);
      return {
        date: a.start.slice(0, 10),
        item: {
          time: a.start.slice(11, 16),
          who: patient?.fullName ?? a.patientId,
          provider: provider?.name ?? a.providerId,
          reason: a.reason,
          status: a.status,
          birthday,
          appointmentId: a.id,
          providerId: a.providerId,
          organizationId: a.organizationId,
          startIso: a.start,
          manage,
        },
      };
    }),
  );

  const changeRequestsRaw =
    actor.role === "medico" && actor.activeOrg?.providerId
      ? await listChangeRequests({ providerId: actor.activeOrg.providerId, status: "pending" })
      : orgId
        ? await listChangeRequests({ organizationId: orgId, status: "pending" })
        : [];
  const changeRequests = await Promise.all(changeRequestsRaw.map(changeRequestView));

  return Response.json({
    role: "staff",
    organization: org
      ? { name: org.name, address: org.address, city: org.city, hours: org.hours, phone: org.phone }
      : null,
    me: {
      name: actor.name,
      role: actor.role,
      specialty: actor.activeOrg?.specialty ?? null,
      canAdmin: Boolean(actor.activeOrg?.canAdmin),
    },
    providers: providers.map((p) => ({
      id: p.id,
      name: p.name,
      specialty: p.specialty,
      roomLabel: p.roomLabel,
      active: p.active,
    })),
    calendar: { title: org ? `Agenda · ${org.name}` : "Agenda", days: groupByDate(rows) },
    providerSettings:
      actor.role === "medico" && actor.activeOrg?.providerId
        ? await getProviderSettings(actor.activeOrg.providerId)
        : null,
    changeRequests,
  });
}
