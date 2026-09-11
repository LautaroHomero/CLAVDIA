import { actorFromRequest } from "@/lib/auth/actor";
import { buildPatientBriefing } from "@/lib/domain/briefing";
import { DEMO_TODAY } from "@/lib/domain/clock";
import {
  earlierOpeningToday,
  getOrganization,
  listPatientNotices,
  patientNextAppointment,
  providerAgenda,
} from "@/lib/db/repo";

/** Live-agenda snapshot for the side panel. Role- and org-aware. */
export async function GET(req: Request) {
  const actor = await actorFromRequest(req);
  if (!actor) return Response.json({ error: "No autenticado." }, { status: 401 });

  if (actor.role === "medico" && actor.activeOrg?.providerId) {
    const a = await providerAgenda(actor.activeOrg.providerId, DEMO_TODAY);
    const target = a.inAttention ?? a.next;
    const briefing = target ? await buildPatientBriefing(target.patientId, actor.activeOrg.id) : null;
    return Response.json({
      role: "medico",
      organization: actor.activeOrg.name,
      clock: a.clock,
      running: a.running,
      offsetMinutes: a.offsetMinutes,
      attendedToday: a.attendedToday,
      inAttention: a.inAttention ?? null,
      next: a.next ?? null,
      upcoming: a.upcoming,
      briefing: briefing?.summary ?? null,
      briefingFor: target?.appointmentId ?? null,
    });
  }

  if (actor.role === "paciente" && actor.patientId) {
    const orgIds = actor.orgs.map((o) => o.id);
    const appt = await patientNextAppointment(actor.patientId, DEMO_TODAY, orgIds);
    const notices = (await listPatientNotices(actor.patientId, DEMO_TODAY)).map((n) => n.message);
    if (!appt) return Response.json({ role: "paciente", hasVisit: false, notices });

    const a = await providerAgenda(appt.providerId, DEMO_TODAY);
    const entry =
      [a.inAttention, a.next, ...a.upcoming].find((e) => e?.appointmentId === appt.id) ?? null;
    const earlier = entry ? await earlierOpeningToday(appt.providerId, DEMO_TODAY, entry.estimated) : undefined;
    const org = await getOrganization(appt.organizationId);
    return Response.json({
      role: "paciente",
      hasVisit: true,
      organization: org?.name ?? "",
      provider: a.providerName,
      reason: appt.reason,
      scheduled: entry?.scheduled ?? null,
      estimated: entry?.estimated ?? null,
      delayMinutes: entry?.delayMinutes ?? 0,
      running: a.running,
      earlierAt: earlier?.time ?? null,
      inProgress: entry?.status === "in-progress",
      notices,
    });
  }

  return Response.json({ role: actor.role, unsupported: true });
}
