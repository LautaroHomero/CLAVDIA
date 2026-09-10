import { actorFromRequest } from "@/lib/auth/actor";
import { getProvider, getProviderSettings, listOpenSlots } from "@/lib/db/repo";

/** Open slots for the manual booking / reschedule pickers. */
export async function GET(req: Request) {
  const actor = actorFromRequest(req);
  if (!actor) return Response.json({ error: "No autenticado." }, { status: 401 });

  const url = new URL(req.url);
  const requestedOrg = url.searchParams.get("organizationId") ?? undefined;
  const date = url.searchParams.get("date") ?? undefined;
  let providerId = url.searchParams.get("providerId") ?? undefined;

  let orgId: string | undefined;
  if (actor.role === "paciente") {
    const orgs = actor.orgs.map((o) => o.id);
    orgId = requestedOrg && orgs.includes(requestedOrg) ? requestedOrg : orgs.length === 1 ? orgs[0] : undefined;
    if (!orgId) return Response.json({ error: "Indicá el consultorio." }, { status: 400 });
  } else {
    orgId = actor.activeOrg?.id;
    if (!orgId) return Response.json({ error: "Sin organización activa." }, { status: 400 });
    if (actor.role === "medico" && actor.activeOrg?.providerId) providerId = actor.activeOrg.providerId;
  }

  const isPatient = actor.role === "paciente";
  const slots = listOpenSlots(orgId, { providerId, date })
    // Patients can't self-book on a professional who keeps changes staff-only.
    .filter((s) => !isPatient || getProviderSettings(s.providerId).whoCanChange !== "staff_only")
    .slice(0, 60)
    .map((s) => {
      const provider = getProvider(s.providerId);
      return {
        slotId: s.id,
        start: s.start,
        durationMinutes: s.durationMinutes,
        providerId: s.providerId,
        provider: provider?.name ?? s.providerId,
        specialty: provider?.specialty,
      };
    });

  return Response.json({ count: slots.length, slots });
}
