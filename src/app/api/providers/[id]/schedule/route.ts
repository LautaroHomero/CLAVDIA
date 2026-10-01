import { actorFromRequest, canEditProviderSchedule } from "@/lib/auth/actor";
import { getProvider, listWeeklyScheduleRules, regenerateProviderSlots, replaceWeeklyScheduleRules } from "@/lib/db/repo";

/** El patrón semanal recurrente de un profesional. */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const actor = await actorFromRequest(req);
  if (!actor || actor.role === "paciente" || !actor.activeOrg) {
    return Response.json({ ok: false, error: "No autorizado." }, { status: 401 });
  }
  const { id: providerId } = await ctx.params;
  const provider = await getProvider(providerId);
  if (!provider) return Response.json({ ok: false, error: "Profesional no encontrado." }, { status: 404 });
  if (provider.organizationId !== actor.activeOrg.id) {
    return Response.json({ ok: false, error: "Ese profesional es de otro consultorio." }, { status: 403 });
  }

  const rules = await listWeeklyScheduleRules(providerId);
  return Response.json({
    ok: true,
    rules: rules.map((r) => ({ weekday: r.weekday, startTime: r.startTime, endTime: r.endTime })),
  });
}

type RuleInput = { weekday?: unknown; startTime?: unknown; endTime?: unknown };

/** Reemplaza el patrón semanal de un profesional y refleja el cambio de inmediato en su agenda. */
export async function PUT(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const actor = await actorFromRequest(req);
  if (!actor || actor.role === "paciente" || !actor.activeOrg) {
    return Response.json({ ok: false, error: "No autorizado." }, { status: 401 });
  }
  const { id: providerId } = await ctx.params;
  const provider = await getProvider(providerId);
  if (!provider) return Response.json({ ok: false, error: "Profesional no encontrado." }, { status: 404 });
  if (!canEditProviderSchedule(actor, provider)) {
    return Response.json(
      { ok: false, error: "Solo el propio profesional o secretaría/admin pueden editar este horario." },
      { status: 403 },
    );
  }

  const body = (await req.json().catch(() => ({}))) as { rules?: RuleInput[] };
  if (!Array.isArray(body.rules)) {
    return Response.json({ ok: false, error: "Falta 'rules'." }, { status: 400 });
  }
  const rules: { weekday: number; startTime: string; endTime: string }[] = [];
  for (const r of body.rules) {
    if (typeof r.weekday !== "number" || typeof r.startTime !== "string" || typeof r.endTime !== "string") {
      return Response.json({ ok: false, error: "Cada franja necesita weekday, startTime y endTime." }, { status: 400 });
    }
    rules.push({ weekday: r.weekday, startTime: r.startTime, endTime: r.endTime });
  }

  try {
    const saved = await replaceWeeklyScheduleRules(providerId, provider.organizationId, rules);
    const { conflicts } = await regenerateProviderSlots(providerId, provider.organizationId);
    return Response.json({
      ok: true,
      rules: saved.map((r) => ({ weekday: r.weekday, startTime: r.startTime, endTime: r.endTime })),
      conflicts,
      message: "Horario semanal actualizado.",
    });
  } catch (err) {
    return Response.json({ ok: false, error: err instanceof Error ? err.message : "No se pudo guardar." }, { status: 400 });
  }
}
