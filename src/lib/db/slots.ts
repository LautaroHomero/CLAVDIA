import type { ScheduleOverride, ScheduleRule, TimeWindow } from "@/lib/domain/types";

/** Turno length — fijo por ahora, no configurable por profesional. */
export const DEFAULT_SLOT_MINUTES = 30;
/** Cuántos días hacia adelante se mantienen `slots` generados. */
export const DEFAULT_WINDOW_DAYS = 30;

const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/**
 * Las franjas bookeables de un día concreto: un override para esa fecha le
 * gana por completo al patrón semanal (franjas propias, o ninguna si está
 * `closed`). Sin override, cae al patrón semanal (`rules`) de ese weekday.
 */
export function resolveDayWindows(
  weekday: number,
  date: string,
  rules: ScheduleRule[],
  overrides: ScheduleOverride[],
): TimeWindow[] {
  const override = overrides.find((o) => o.date === date);
  if (override) return override.closed ? [] : override.windows;
  return rules.filter((r) => r.weekday === weekday).map((r) => ({ startTime: r.startTime, endTime: r.endTime }));
}

/** Expande las franjas de un día en slots de `slotMinutes`, con el mismo esquema de id que antes. */
export function desiredSlotsForDay(
  providerId: string,
  date: string,
  windows: TimeWindow[],
  opts: { slotMinutes?: number; notBefore?: string } = {},
): { id: string; providerId: string; start: string }[] {
  const slotMinutes = opts.slotMinutes ?? DEFAULT_SLOT_MINUTES;
  const out: { id: string; providerId: string; start: string }[] = [];
  for (const w of windows) {
    const [sh, sm] = w.startTime.split(":").map(Number);
    const [eh, em] = w.endTime.split(":").map(Number);
    const end = new Date(date + "T00:00:00");
    end.setHours(eh, em, 0, 0);
    let d = new Date(date + "T00:00:00");
    d.setHours(sh, sm, 0, 0);
    while (d.getTime() < end.getTime()) {
      const start = `${date}T${pad(d.getHours())}:${pad(d.getMinutes())}:00`;
      if (!opts.notBefore || start >= opts.notBefore) {
        out.push({ id: `slot_${providerId}_${date}_${pad(d.getHours())}${pad(d.getMinutes())}`, providerId, start });
      }
      d = new Date(d.getTime() + slotMinutes * 60000);
    }
  }
  return out;
}

/**
 * Todos los slots deseados para un profesional en `days` días a partir de
 * `fromDate`, según su patrón semanal + overrides. El día `fromDate` se
 * recorta a partir de `notBeforeToday` (siempre hay que poder sacar turno
 * "para hoy" desde ahora, no desde la apertura si ya pasó).
 */
export function desiredSlots(
  providerId: string,
  rules: ScheduleRule[],
  overrides: ScheduleOverride[],
  opts: { fromDate: string; notBeforeToday: string; days?: number; slotMinutes?: number },
): { id: string; providerId: string; start: string }[] {
  const days = opts.days ?? DEFAULT_WINDOW_DAYS;
  const base = new Date(opts.fromDate + "T00:00:00");
  const out: { id: string; providerId: string; start: string }[] = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(base.getFullYear(), base.getMonth(), base.getDate() + i);
    const date = ymd(d);
    const windows = resolveDayWindows(d.getDay(), date, rules, overrides);
    out.push(
      ...desiredSlotsForDay(providerId, date, windows, {
        slotMinutes: opts.slotMinutes,
        notBefore: i === 0 ? opts.notBeforeToday : undefined,
      }),
    );
  }
  return out;
}

/** Valida un conjunto de franjas de un mismo día: formato HH:MM, fin > inicio, sin solaparse. */
export function validateWindows(windows: TimeWindow[]): string | null {
  const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
  for (const w of windows) {
    if (!HHMM.test(w.startTime) || !HHMM.test(w.endTime)) return `Horario inválido: "${w.startTime}–${w.endTime}".`;
    if (w.endTime <= w.startTime) return `El horario "${w.startTime}–${w.endTime}" termina antes de empezar.`;
  }
  const sorted = [...windows].sort((a, b) => a.startTime.localeCompare(b.startTime));
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].startTime < sorted[i - 1].endTime) {
      return `Las franjas "${sorted[i - 1].startTime}–${sorted[i - 1].endTime}" y "${sorted[i].startTime}–${sorted[i].endTime}" se superponen.`;
    }
  }
  return null;
}
