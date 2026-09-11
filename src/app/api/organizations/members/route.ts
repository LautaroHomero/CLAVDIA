import { actorFromRequest } from "@/lib/auth/actor";
import { getOrganization, listOrgMembers, setOrgAdmin } from "@/lib/db/repo";

/**
 * Equipo del consultorio activo, con quién lo administra. Solo para quien ya
 * administra — se usa para designar (o quitar) admins a otros miembros.
 */
export async function GET(req: Request) {
  const actor = await actorFromRequest(req);
  if (!actor || actor.role === "paciente" || !actor.activeOrg) {
    return Response.json({ ok: false, error: "No autorizado." }, { status: 401 });
  }
  if (!actor.activeOrg.canAdmin) {
    return Response.json({ ok: false, error: "Solo un administrador puede ver esto." }, { status: 403 });
  }
  return Response.json({ ok: true, members: await listOrgMembers(actor.activeOrg.id) });
}

/** Otorga o quita el rol de administrador a otro miembro del equipo. */
export async function PATCH(req: Request) {
  const actor = await actorFromRequest(req);
  if (!actor || actor.role === "paciente" || !actor.activeOrg) {
    return Response.json({ ok: false, error: "No autorizado." }, { status: 401 });
  }
  if (!actor.activeOrg.canAdmin) {
    return Response.json({ ok: false, error: "Solo un administrador puede designar administradores." }, { status: 403 });
  }

  const body = (await req.json().catch(() => ({}))) as { userId?: string; isAdmin?: boolean };
  const userId = body.userId?.trim();
  if (!userId || typeof body.isAdmin !== "boolean") {
    return Response.json({ ok: false, error: "Faltan 'userId' y/o 'isAdmin'." }, { status: 400 });
  }

  const orgId = actor.activeOrg.id;
  const members = await listOrgMembers(orgId);
  const target = members.find((m) => m.userId === userId);
  if (!target) {
    return Response.json({ ok: false, error: "Esa persona no es del equipo de este consultorio." }, { status: 404 });
  }

  if (!body.isAdmin) {
    const org = await getOrganization(orgId);
    const remainingAdmins = (org?.adminIds ?? []).filter((id) => id !== userId);
    if (remainingAdmins.length === 0) {
      return Response.json(
        { ok: false, error: "No se puede quitar al último administrador del consultorio." },
        { status: 409 },
      );
    }
  }

  await setOrgAdmin(orgId, userId, body.isAdmin);
  return Response.json({
    ok: true,
    member: { userId, name: target.name, isAdmin: body.isAdmin },
    message: body.isAdmin
      ? `${target.name} ahora administra el consultorio.`
      : `${target.name} ya no administra el consultorio.`,
  });
}
