import { createHmac, timingSafeEqual } from "node:crypto";
import type { Actor } from "@/lib/domain/types";

export const SESSION_COOKIE = "clinic_session";
const MAX_AGE_SECONDS = 60 * 60 * 12; // 12h

function secret(): string {
  return process.env.AUTH_SECRET || "dev-only-insecure-secret-change-me";
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

/** Signs an Actor into a compact `payload.signature` token. */
export function signSession(actor: Actor): string {
  const body = b64url(JSON.stringify({ ...actor, iat: Date.now() }));
  const sig = b64url(createHmac("sha256", secret()).update(body).digest());
  return `${body}.${sig}`;
}

export function verifySession(token: string | undefined | null): Actor | null {
  if (!token) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;

  const expected = b64url(createHmac("sha256", secret()).update(body).digest());
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  try {
    const parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Actor & {
      iat: number;
    };
    if (!parsed.iat || Date.now() - parsed.iat > MAX_AGE_SECONDS * 1000) return null;
    return {
      userId: parsed.userId,
      name: parsed.name,
      role: parsed.role,
      patientId: parsed.patientId,
      providerId: parsed.providerId,
      specialty: parsed.specialty,
    };
  } catch {
    return null;
  }
}

/** Reads + verifies the session from a Fetch API Request's Cookie header. */
export function actorFromRequest(req: Request): Actor | null {
  const cookie = req.headers.get("cookie") ?? "";
  const match = cookie.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`));
  return verifySession(match?.[1] ? decodeURIComponent(match[1]) : null);
}

export function sessionSetCookie(token: string): string {
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${MAX_AGE_SECONDS}`;
}

export function sessionClearCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}
