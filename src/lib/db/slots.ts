import { DEMO_TODAY } from "@/lib/domain/clock";

const pad = (n: number) => String(n).padStart(2, "0");

/**
 * Bookable slots for a provider: the next `weekdays` weekdays from the demo's
 * "today", 09:00–12:00 every 30 minutes. Used by the seed and by the
 * `registerProfessional` tool so a new professional has an agenda immediately.
 */
export function generateSlotRows(
  providerId: string,
  weekdays = 6,
): { id: string; providerId: string; start: string }[] {
  const out: { id: string; providerId: string; start: string }[] = [];
  const base = new Date(`${DEMO_TODAY}T00:00:00`);
  let added = 0;
  let offset = 1;
  while (added < weekdays) {
    const day = new Date(base);
    day.setDate(base.getDate() + offset++);
    if (day.getDay() === 0 || day.getDay() === 6) continue;
    added++;
    const d = `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`;
    for (let h = 9; h < 12; h++) {
      for (const m of [0, 30]) {
        out.push({
          id: `slot_${providerId}_${d}_${pad(h)}${pad(m)}`,
          providerId,
          start: `${d}T${pad(h)}:${pad(m)}:00`,
        });
      }
    }
  }
  return out;
}
