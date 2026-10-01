-- Track whether a turno's reminder email was already sent, so the reminders
-- cron endpoint (`GET /api/cron/reminders`) is safe to call as often as
-- needed without sending duplicates.
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS reminder_sent_at TEXT;
