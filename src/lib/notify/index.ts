/**
 * Outbound notifications (today: patient PIN-recovery codes).
 *
 * The transport is pluggable so the delivery provider is a deployment decision,
 * not a code change. `NOTIFY_TRANSPORT` selects it; the default `log` transport
 * prints the message to the server console, which is enough for local dev and
 * for a first deploy while an email/WhatsApp provider is being chosen.
 */

export type NotifyChannel = "email" | "whatsapp";

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

let cached: Notifier | undefined;

export function getNotifier(): Notifier {
  if (cached) return cached;
  const transport = (process.env.NOTIFY_TRANSPORT ?? "log").toLowerCase();
  switch (transport) {
    // case "resend": cached = new ResendNotifier(); break;
    // case "twilio": cached = new TwilioNotifier(); break;
    case "log":
      cached = new LogNotifier();
      break;
    default:
      console.warn(`[notify] NOTIFY_TRANSPORT="${transport}" no implementado todavía; usando "log".`);
      cached = new LogNotifier();
  }
  return cached;
}
