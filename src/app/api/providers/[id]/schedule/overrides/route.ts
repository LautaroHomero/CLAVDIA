import { actorFromRequest } from "@/lib/auth/actor";
import { getProvider, listScheduleOverrides } from "@/lib/db/repo";
import { DEMO_TODAY } from "@/lib/domain/clock";
import { DEFAULT_WINDOW_DAYS } from "@/lib/db/slots";

const pad = (n: number) => String(n).padStart(2, "0");
const addDaysStr = (dateStr: string, n: number) => {
  const d = new Date(dateStr + "T00:00:00");
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

/** Overrides puntuales por fecha de un profesional, en `?from=&to=` (default: la ventana de agenda generada). */
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

  const url = new URL(req.url);
  const from = url.searchParams.get("from") ?? DEMO_TODAY;
  const to = url.searchParams.get("to") ?? addDaysStr(DEMO_TODAY, DEFAULT_WINDOW_DAYS);

  const overrides = await listScheduleOverrides(providerId, { from, to });
  return Response.json({ ok: true, overrides });
}
