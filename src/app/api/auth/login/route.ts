import { getUserByEmail, membershipsForUser } from "@/lib/db/repo";
import { verifyPin } from "@/lib/auth/pin";
import { hydrateActor } from "@/lib/auth/actor";
import { sessionSetCookie, signSession, type SessionClaims } from "@/lib/auth/session";

/**
 * Unified login: email + PIN for every role. Staff with more than one
 * organization and no `organizationId` get `{ needsOrg: true, organizations }`
 * so the client can ask which one to enter.
 */
export async function POST(req: Request) {
  const { email, pin, organizationId } = (await req.json()) as {
    email?: string;
    pin?: string;
    organizationId?: string;
  };

  if (!email?.trim() || !pin) {
    return Response.json({ ok: false, error: "Ingresá tu email y tu PIN." }, { status: 400 });
  }

  const user = getUserByEmail(email);
  if (!user || !verifyPin(pin, user.pinHash, user.pinSalt)) {
    return Response.json({ ok: false, error: "Email o PIN incorrecto." }, { status: 401 });
  }

  const claims: SessionClaims = { userId: user.id, role: user.role, patientId: user.patientId };

  if (user.role !== "paciente") {
    const mems = membershipsForUser(user.id);
    if (mems.length === 0) {
      return Response.json(
        { ok: false, error: "Ese usuario no está en ninguna organización." },
        { status: 403 },
      );
    }
    if (mems.length > 1 && !organizationId) {
      return Response.json({
        ok: true,
        needsOrg: true,
        organizations: mems.map((m) => ({ id: m.organizationId, name: m.organizationName, role: m.role })),
      });
    }
    const chosen = organizationId
      ? mems.find((m) => m.organizationId === organizationId)
      : mems[0];
    if (!chosen) {
      return Response.json(
        { ok: false, error: "Ese usuario no trabaja en el consultorio elegido." },
        { status: 403 },
      );
    }
    claims.activeOrgId = chosen.organizationId;
    claims.role = chosen.role;
  }

  const actor = hydrateActor(claims);
  return Response.json(
    { ok: true, actor },
    { headers: { "Set-Cookie": sessionSetCookie(signSession(claims)) } },
  );
}
