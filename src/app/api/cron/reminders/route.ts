import { authorizedCronRequest } from "@/lib/auth/cron";
import { appointmentsNeedingReminder, markReminderSent } from "@/lib/db/repo";
import { notifyAppointmentReminder } from "@/lib/domain/appointment-notifications";

// Always recompute the window at request time — never cache/prerender this.
export const dynamic = "force-dynamic";

/** How far ahead of a turno's start we consider it "due" for a reminder. */
const REMINDER_LEAD_HOURS = 24;

const pad = (n: number) => String(n).padStart(2, "0");
/** Local naive `YYYY-MM-DDThh:mm:ss`, matching how `appointments.start` is stored. */
const localIso = (d: Date) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

/**
 * Turno reminders, meant to be hit periodically by an external cron (see
 * README §8 "Recordatorios de turno"). Finds scheduled appointments starting
 * within the next `REMINDER_LEAD_HOURS` hours that don't have a reminder
 * sent yet (`reminder_sent_at`), sends the email, and marks them — so it's
 * safe to call this as often as the cron is configured to run without
 * sending duplicates, whatever the cadence.
 */
export async function GET(req: Request) {
  if (!process.env.CRON_SECRET) {
    console.warn("[cron/reminders] CRON_SECRET no configurado: el endpoint queda sin protección por secreto.");
  }
  if (!authorizedCronRequest(req)) {
    return Response.json({ ok: false, error: "No autorizado." }, { status: 401 });
  }

  const now = new Date();
  const windowEnd = new Date(now.getTime() + REMINDER_LEAD_HOURS * 3_600_000);
  const due = await appointmentsNeedingReminder(localIso(now), localIso(windowEnd));

  for (const appointment of due) {
    await notifyAppointmentReminder(appointment);
    await markReminderSent(appointment.id);
  }

  return Response.json({ ok: true, processed: due.length });
}
