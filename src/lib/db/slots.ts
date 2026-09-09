import { DEMO_TODAY, demoHalfHourFloor } from "@/lib/domain/clock";

const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/**
 * Bookable slots for a provider:
 *  - **today**: from the current half hour to +6 h, every 30 min (so there are
 *    always free slots around "now" — for "sacar turno hoy" / "ir más temprano");
 *  - the next `futureDays` days: 09:00–13:00, every 30 min.
 *
 * Used by the seed and by `registerProfessional` so a new professional has an
 * agenda immediately.
 */
export function generateSlotRows(
  providerId: string,
  futureDays = 6,
): { id: string; providerId: string; start: string }[] {
  const out: { id: string; providerId: string; start: string }[] = [];
  const push = (start: string) =>
    out.push({ id: `slot_${providerId}_${start.slice(0, 10)}_${start.slice(11, 13)}${start.slice(14, 16)}`, providerId, start });

  // today: rolling window around now
  const t0 = new Date(demoHalfHourFloor());
  for (let i = 0; i < 12; i++) {
    const d = new Date(t0.getTime() + i * 30 * 60000);
    if (ymd(d) !== DEMO_TODAY) break; // stop at midnight
    push(`${ymd(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}:00`);
  }

  // next days: business hours
  const base = new Date(`${DEMO_TODAY}T00:00:00`);
  for (let day = 1; day <= futureDays; day++) {
    const d = new Date(base.getFullYear(), base.getMonth(), base.getDate() + day);
    const date = ymd(d);
    for (let h = 9; h < 13; h++) for (const m of [0, 30]) push(`${date}T${pad(h)}:${pad(m)}:00`);
  }
  return out;
}
