import { authorizedCronRequest } from "@/lib/auth/cron";
import { listAllActiveProviders, regenerateProviderSlots } from "@/lib/db/repo";

// Always recompute at request time — never cache/prerender this.
export const dynamic = "force-dynamic";

const pad = (n: number) => String(n).padStart(2, "0");
/** Fecha y "ahora" reales del reloj del sistema (naive local), no `DEMO_TODAY`. */
function localDateAndNow(d: Date): { date: string; time: string } {
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return { date, time: `${date}T${pad(d.getHours())}:${pad(d.getMinutes())}:00` };
}

/**
 * Rueda hacia adelante la ventana de `slots` reservables de cada profesional
 * activo, a partir de su horario configurado (patrón semanal + overrides).
 * Meant to be hit once a día por un cron externo (ver README §8 y
 * `cron/reminders/route.ts`, del mismo estilo). Usa la fecha real del
 * sistema — no `DEMO_TODAY` (`src/lib/domain/clock.ts`), que queda fijo desde
 * que arrancó el proceso y no "rueda" por sí sola día a día.
 */
export async function GET(req: Request) {
  if (!process.env.CRON_SECRET) {
    console.warn("[cron/regenerate-schedules] CRON_SECRET no configurado: el endpoint queda sin protección por secreto.");
  }
  if (!authorizedCronRequest(req)) {
    return Response.json({ ok: false, error: "No autorizado." }, { status: 401 });
  }

  const { date, time } = localDateAndNow(new Date());
  const providers = await listAllActiveProviders();

  let created = 0;
  let removed = 0;
  let conflicts = 0;
  for (const p of providers) {
    const r = await regenerateProviderSlots(p.id, p.organizationId, { fromDate: date, nowIso: time });
    created += r.created;
    removed += r.removed;
    conflicts += r.conflicts;
  }

  return Response.json({ ok: true, providers: providers.length, created, removed, conflicts });
}
