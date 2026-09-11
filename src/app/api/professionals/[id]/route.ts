import { actorFromRequest } from "@/lib/auth/actor";
import { getProvider, setProviderActive } from "@/lib/db/repo";

/**
 * Dar de baja / reactivar un profesional del equipo. Solo quien administra el
 * consultorio (secretaría, o el médico fundador). No borra nada: un
 * profesional inactivo sale de la agenda para turnos nuevos pero su
 * historial (turnos, facturas, informes) queda intacto — ver
 * `setProviderActive` y `listOpenSlots` en `src/lib/db/repo.ts`.
 */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const actor = await actorFromRequest(req);
  if (!actor || actor.role === "paciente" || !actor.activeOrg) {
    return Response.json({ ok: false, error: "No autorizado." }, { status: 401 });
  }
  if (!actor.activeOrg.canAdmin) {
    return Response.json(
      { ok: false, error: "Solo la secretaría administrativa puede dar de baja al equipo." },
      { status: 403 },
    );
  }

  const { id } = await ctx.params;
  const provider = await getProvider(id);
  if (!provider) return Response.json({ ok: false, error: "Profesional no encontrado." }, { status: 404 });
  if (provider.organizationId !== actor.activeOrg.id) {
    return Response.json({ ok: false, error: "Ese profesional es de otro consultorio." }, { status: 403 });
  }

  const body = (await req.json().catch(() => ({}))) as { active?: boolean };
  if (typeof body.active !== "boolean") {
    return Response.json({ ok: false, error: "Falta indicar 'active'." }, { status: 400 });
  }

  await setProviderActive(id, body.active);
  return Response.json({
    ok: true,
    provider: { id: provider.id, name: provider.name, active: body.active },
    message: body.active
      ? `${provider.name} vuelve a estar activo/a.`
      : `${provider.name} fue dado/a de baja: no aparece más para turnos nuevos, pero su historial se conserva.`,
  });
}
