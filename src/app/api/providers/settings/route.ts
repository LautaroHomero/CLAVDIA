import { actorFromRequest } from "@/lib/auth/actor";
import { getProviderSettings, setProviderSettings } from "@/lib/db/repo";
import type { LateChangePolicy, WhoCanChange } from "@/lib/domain/types";

const WHO: WhoCanChange[] = ["anyone", "staff_only"];
const LATE: LateChangePolicy[] = ["direct", "needs_approval"];

/** The professional's own policy for manual appointment changes on their agenda. */
export async function GET(req: Request) {
  const actor = await actorFromRequest(req);
  if (!actor) return Response.json({ error: "No autenticado." }, { status: 401 });
  const providerId = actor.role === "medico" ? actor.activeOrg?.providerId : undefined;
  if (!providerId) return Response.json({ error: "Solo el profesional." }, { status: 403 });
  return Response.json({ ok: true, settings: await getProviderSettings(providerId) });
}

export async function PATCH(req: Request) {
  const actor = await actorFromRequest(req);
  if (!actor) return Response.json({ ok: false, error: "No autenticado." }, { status: 401 });
  const providerId = actor.role === "medico" ? actor.activeOrg?.providerId : undefined;
  if (!providerId) return Response.json({ ok: false, error: "Solo el profesional." }, { status: 403 });

  const body = (await req.json()) as { whoCanChange?: string; lateChangePolicy?: string };
  const patch: { whoCanChange?: WhoCanChange; lateChangePolicy?: LateChangePolicy } = {};
  if (body.whoCanChange !== undefined) {
    if (!WHO.includes(body.whoCanChange as WhoCanChange)) {
      return Response.json({ ok: false, error: "Valor inválido para whoCanChange." }, { status: 400 });
    }
    patch.whoCanChange = body.whoCanChange as WhoCanChange;
  }
  if (body.lateChangePolicy !== undefined) {
    if (!LATE.includes(body.lateChangePolicy as LateChangePolicy)) {
      return Response.json({ ok: false, error: "Valor inválido para lateChangePolicy." }, { status: 400 });
    }
    patch.lateChangePolicy = body.lateChangePolicy as LateChangePolicy;
  }

  return Response.json({ ok: true, settings: await setProviderSettings(providerId, patch) });
}
