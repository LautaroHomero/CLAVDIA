/**
 * The demo is pinned to a fixed "today" because the seeded appointments, slots
 * and lab results are all built around this date. Everything that reasons about
 * "hoy" / "mañana" must use this, and the agent is told about it in the workflow.
 */
export const DEMO_TODAY = "2026-09-09"; // YYYY-MM-DD
export const DEMO_TOMORROW = "2026-09-10";

// Human labels in es-AR (2026-09-09 is a Wednesday).
export const DEMO_TODAY_LABEL = "miércoles 9 de septiembre de 2026";
export const DEMO_TOMORROW_LABEL = "jueves 10 de septiembre de 2026";
