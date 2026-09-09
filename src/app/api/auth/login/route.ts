import { getUserByName, membershipsForUser } from "@/lib/db/repo";
import { verifyPin } from "@/lib/auth/pin";
import { hydrateActor } from "@/lib/auth/actor";
import { sessionSetCookie, signSession, type SessionClaims } from "@/lib/auth/session";

type LoginKind = "paciente" | "profesional";

export async function POST(req: Request) {
  const { kind, name, pin, organizationId } = (await req.json()) as {
    kind?: LoginKind;
    name?: string;
    pin?: string;
    organizationId?: string;
  };

  if (!kind || !name?.trim() || !pin) {
    return Response.json({ ok: false, error: "Faltan datos." }, { status: 400 });
  }

  const user = getUserByName(name);
  if (!user || !verifyPin(pin, user.pinHash, user.pinSalt)) {
    return Response.json({ ok: false, error: "Nombre o PIN incorrecto." }, { status: 401 });
  }

  const isPatient = user.role === "paciente";
  if (isPatient !== (kind === "paciente")) {
    return Response.json(
      { ok: false, error: "Ese usuario no corresponde a ese perfil." },
      { status: 401 },
    );
  }

  const claims: SessionClaims = { userId: user.id, role: user.role, patientId: user.patientId };

  if (!isPatient) {
    const mems = membershipsForUser(user.id);
    if (mems.length === 0) {
      return Response.json({ ok: false, error: "Ese usuario no está en ninguna organización." }, { status: 403 });
    }
    if (mems.length > 1 && !organizationId) {
      // ask the client to pick which org
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
