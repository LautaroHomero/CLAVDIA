import { createHmac, timingSafeEqual } from "node:crypto";
import type { Role } from "@/lib/domain/types";

export const SESSION_COOKIE = "clinic_session";
const MAX_AGE_SECONDS = 60 * 60 * 12; // 12h

/** What actually lives in the signed cookie — the full Actor is rehydrated per request. */
export interface SessionClaims {
  userId: string;
  role: Role;
  patientId?: string;
  /** For staff: the organization chosen at login. */
  activeOrgId?: string;
}

function secret(): string {
  return process.env.AUTH_SECRET || "dev-only-insecure-secret-change-me";
}
const b64url = (input: Buffer | string) => Buffer.from(input).toString("base64url");

export function signSession(claims: SessionClaims): string {
  const body = b64url(JSON.stringify({ ...claims, iat: Date.now() }));
  const sig = b64url(createHmac("sha256", secret()).update(body).digest());
  return `${body}.${sig}`;
}

export function verifySession(token: string | undefined | null): SessionClaims | null {
  if (!token) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;

  const expected = b64url(createHmac("sha256", secret()).update(body).digest());
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  try {
    const parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as SessionClaims & {
      iat: number;
    };
    if (!parsed.iat || Date.now() - parsed.iat > MAX_AGE_SECONDS * 1000) return null;
    return {
      userId: parsed.userId,
      role: parsed.role,
      patientId: parsed.patientId,
      activeOrgId: parsed.activeOrgId,
    };
  } catch {
    return null;
  }
}

export function claimsFromRequest(req: Request): SessionClaims | null {
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
