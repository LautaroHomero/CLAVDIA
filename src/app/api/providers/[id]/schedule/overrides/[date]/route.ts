import { actorFromRequest, canEditProviderSchedule } from "@/lib/auth/actor";
import {
  clearScheduleOverrideForDate,
  getProvider,
  regenerateProviderSlots,
  setScheduleOverrideForDate,
} from "@/lib/db/repo";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

async function authorize(req: Request, providerId: string) {
  const actor = await actorFromRequest(req);
  if (!actor || actor.role === "paciente" || !actor.activeOrg) {
    return { error: Response.json({ ok: false, error: "No autorizado." }, { status: 401 }) };
  }
  const provider = await getProvider(providerId);
  if (!provider) {
    return { error: Response.json({ ok: false, error: "Profesional no encontrado." }, { status: 404 }) };
  }
  if (!canEditProviderSchedule(actor, provider)) {
    return {
      error: Response.json(
        { ok: false, error: "Solo el propio profesional o secretaría/admin pueden editar este horario." },
        { status: 403 },
      ),
    };
  }
  return { provider };
}

type WindowInput = { startTime?: unknown; endTime?: unknown };

/** Define el horario de una fecha puntual: `{closed:true}` o `{windows:[...]}` (franjas propias, libres de cualquier patrón). */
export async function PUT(req: Request, ctx: { params: Promise<{ id: string; date: string }> }) {
  const { id: providerId, date } = await ctx.params;
  if (!DATE_RE.test(date)) return Response.json({ ok: false, error: "Fecha inválida." }, { status: 400 });

  const auth = await authorize(req, providerId);
  if (auth.error) return auth.error;
  const provider = auth.provider!;

  const body = (await req.json().catch(() => ({}))) as { closed?: unknown; windows?: WindowInput[] };

  try {
    if (body.closed === true) {
      await setScheduleOverrideForDate(providerId, provider.organizationId, date, { closed: true });
    } else {
      if (!Array.isArray(body.windows)) {
        return Response.json({ ok: false, error: "Falta 'windows', o indicá closed:true." }, { status: 400 });
      }
      const windows: { startTime: string; endTime: string }[] = [];
      for (const w of body.windows) {
        if (typeof w.startTime !== "string" || typeof w.endTime !== "string") {
          return Response.json({ ok: false, error: "Cada franja necesita startTime y endTime." }, { status: 400 });
        }
        windows.push({ startTime: w.startTime, endTime: w.endTime });
      }
      await setScheduleOverrideForDate(providerId, provider.organizationId, date, { windows });
    }
    const { conflicts } = await regenerateProviderSlots(providerId, provider.organizationId);
    return Response.json({ ok: true, conflicts, message: `Horario del ${date} actualizado.` });
  } catch (err) {
    return Response.json({ ok: false, error: err instanceof Error ? err.message : "No se pudo guardar." }, { status: 400 });
  }
}

/** Quita el override de una fecha puntual: ese día vuelve a regirse por el patrón semanal. */
export async function DELETE(req: Request, ctx: { params: Promise<{ id: string; date: string }> }) {
  const { id: providerId, date } = await ctx.params;
  if (!DATE_RE.test(date)) return Response.json({ ok: false, error: "Fecha inválida." }, { status: 400 });

  const auth = await authorize(req, providerId);
  if (auth.error) return auth.error;
  const provider = auth.provider!;

  await clearScheduleOverrideForDate(providerId, date);
  const { conflicts } = await regenerateProviderSlots(providerId, provider.organizationId);
  return Response.json({ ok: true, conflicts, message: `El ${date} vuelve al horario habitual.` });
}
