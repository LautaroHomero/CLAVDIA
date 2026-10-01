/**
 * Outbound notifications (today: patient PIN-recovery codes).
 *
 * The provider is chosen per channel, based on which credentials are present
 * in the environment — not by one global switch — because a single request
 * (e.g. PIN recovery) may need to send over whichever channel the patient
 * picked. `channel: "email"` goes through Resend if `RESEND_API_KEY` is set;
 * `channel: "sms"` goes through Twilio if its credentials are set. Anything
 * without credentials configured falls back to logging to the server
 * console, which is enough for local dev and for a first deploy while a
 * provider is being chosen. `whatsapp` is a channel type kept for a possible
 * future integration but is not implemented anywhere yet.
 */

export type NotifyChannel = "email" | "sms" | "whatsapp";

export interface OutboundMessage {
  channel: NotifyChannel;
  /** Real destination: an email address or an E.164-ish phone number. */
  to: string;
  subject?: string;
  body: string;
}

export interface Notifier {
  send(msg: OutboundMessage): Promise<void>;
}

/** Dev transport — writes the message to the server log. Swap for Resend/Twilio in prod. */
class LogNotifier implements Notifier {
  async send(msg: OutboundMessage): Promise<void> {
    const rule = "─".repeat(56);
    console.info(
      `\n${rule}\n[notify:${msg.channel}] → ${msg.to}` +
        (msg.subject ? `\nasunto: ${msg.subject}` : "") +
        `\n${msg.body}\n${rule}\n`,
    );
  }
}

/**
 * Real email transport via Resend's REST API (https://resend.com/docs/api-reference/emails/send-email).
 * Uses `fetch` directly instead of the `resend` npm package — one HTTP call
 * doesn't justify a new dependency. Only handles `channel: "email"`.
 */
class ResendNotifier implements Notifier {
  async send(msg: OutboundMessage): Promise<void> {
    if (msg.channel !== "email") {
      console.warn(`[notify:resend] canal "${msg.channel}" no soportado (solo "email"); no se envió.`);
      return;
    }
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) {
      console.error("[notify:resend] falta RESEND_API_KEY; no se pudo enviar el mail.");
      return;
    }
    const from = process.env.RESEND_FROM?.trim() || "Clavdia <onboarding@resend.dev>";
    try {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from,
          to: [msg.to],
          subject: msg.subject ?? "Clavdia",
          text: msg.body,
        }),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        console.error(`[notify:resend] Resend respondió ${res.status} al enviar a ${msg.to}: ${detail}`);
      }
    } catch (err) {
      // Never let a delivery failure break the caller's flow (booking, PIN
      // recovery, etc.) — this is best-effort, logged for follow-up.
      console.error(`[notify:resend] error de red enviando a ${msg.to}:`, err);
    }
  }
}

/**
 * Real SMS transport via Twilio's REST API
 * (https://www.twilio.com/docs/sms/api/message-resource#create-a-message-resource).
 * Uses `fetch` directly instead of the `twilio` npm package — one HTTP call
 * doesn't justify a new dependency. Only handles `channel: "sms"`. Uses
 * `TWILIO_FROM` (a separate, SMS-capable Twilio number) — deliberately not
 * `TWILIO_WHATSAPP_FROM`, which is a distinct Twilio resource for an
 * unimplemented WhatsApp channel.
 */
class TwilioSmsNotifier implements Notifier {
  async send(msg: OutboundMessage): Promise<void> {
    if (msg.channel !== "sms") {
      console.warn(`[notify:twilio] canal "${msg.channel}" no soportado (solo "sms"); no se envió.`);
      return;
    }
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    const from = process.env.TWILIO_FROM?.trim();
    if (!accountSid || !authToken || !from) {
      console.error("[notify:twilio] falta TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN/TWILIO_FROM; no se pudo enviar el SMS.");
      return;
    }
    try {
      const res = await fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
        {
          method: "POST",
          headers: {
            Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}`,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({ To: msg.to, From: from, Body: msg.body }),
        },
      );
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        console.error(`[notify:twilio] Twilio respondió ${res.status} al enviar a ${msg.to}: ${detail}`);
      }
    } catch (err) {
      // Never let a delivery failure break the caller's flow (booking, PIN
      // recovery, etc.) — this is best-effort, logged for follow-up.
      console.error(`[notify:twilio] error de red enviando a ${msg.to}:`, err);
    }
  }
}

const logNotifier = new LogNotifier();
let resendNotifier: Notifier | undefined;
let twilioNotifier: Notifier | undefined;

function notifierFor(channel: NotifyChannel): Notifier {
  switch (channel) {
    case "email":
      if (process.env.RESEND_API_KEY) {
        resendNotifier ??= new ResendNotifier();
        return resendNotifier;
      }
      return logNotifier;
    case "sms":
      if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM) {
        twilioNotifier ??= new TwilioSmsNotifier();
        return twilioNotifier;
      }
      return logNotifier;
    default:
      return logNotifier;
  }
}

/**
 * Dispatches per-message to whichever provider is configured for that
 * message's channel (see `notifierFor`), so email and SMS can be active at
 * the same time instead of one global transport switch.
 */
class RoutingNotifier implements Notifier {
  async send(msg: OutboundMessage): Promise<void> {
    return notifierFor(msg.channel).send(msg);
  }
}

const routingNotifier = new RoutingNotifier();

export function getNotifier(): Notifier {
  return routingNotifier;
}
