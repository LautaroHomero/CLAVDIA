/**
 * The demo anchors "today" to the real date at server start and seeds the live
 * agenda relative to the current time, so it looks sensible whenever you run it.
 *
 * These are module-level singletons: fixed for the lifetime of the process
 * (a `rm -rf data && npm run dev` re-seeds against the new "now").
 */
const NOW = new Date();

const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const iso = (d: Date) => `${ymd(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}:00`;
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

export const DEMO_TODAY = ymd(NOW); // YYYY-MM-DD
export const DEMO_TOMORROW = ymd(addDays(NOW, 1));

/** "MM-DD" of today — used to make a seeded patient's birthday always land today. */
export const DEMO_MMDD = `${pad(NOW.getMonth() + 1)}-${pad(NOW.getDate())}`;

const label = (d: Date) =>
  d.toLocaleDateString("es-AR", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
export const DEMO_TODAY_LABEL = label(NOW);
export const DEMO_TOMORROW_LABEL = label(addDays(NOW, 1));

/** The current time floored to the previous :00 / :30 — the initial agenda clock. */
export function demoHalfHourFloor(): string {
  const d = new Date(NOW);
  d.setMinutes(d.getMinutes() < 30 ? 0 : 30, 0, 0);
  return iso(d);
}

/** First :00 / :30 slot strictly after now + `bufferMin`. */
export function demoNextSlot(bufferMin = 10): string {
  const d = new Date(NOW.getTime() + bufferMin * 60000);
  d.setMinutes(d.getMinutes() < 30 ? 30 : 60, 0, 0);
  return iso(d);
}

/** Shift a local `YYYY-MM-DDThh:mm:ss` string by N minutes, seconds zeroed. */
export function shiftIso(isoStr: string, minutes: number): string {
  const d = new Date(isoStr);
  d.setMinutes(d.getMinutes() + minutes, 0, 0);
  return iso(d);
}
