import { getUserByName } from "@/lib/db/repo";
import { verifyPin } from "@/lib/auth/pin";
import { sessionSetCookie, signSession } from "@/lib/auth/session";
import type { Actor, Role } from "@/lib/domain/types";

type LoginKind = "paciente" | "profesional";

const ROLES_FOR_KIND: Record<LoginKind, Role[]> = {
  paciente: ["paciente"],
  profesional: ["medico", "recepcion"],
};

export async function POST(req: Request) {
  const { kind, name, pin } = (await req.json()) as {
    kind?: LoginKind;
    name?: string;
    pin?: string;
  };

  if (!kind || !ROLES_FOR_KIND[kind] || !name?.trim() || !pin) {
    return Response.json({ ok: false, error: "Faltan datos." }, { status: 400 });
  }

  const user = getUserByName(name, ROLES_FOR_KIND[kind]);
  if (!user || !verifyPin(pin, user.pinHash, user.pinSalt)) {
    return Response.json(
      { ok: false, error: "Nombre o PIN incorrecto (o no corresponde a ese perfil)." },
      { status: 401 },
    );
  }

  const actor: Actor = {
    userId: user.id,
    name: user.name,
    role: user.role,
    patientId: user.patientId,
    providerId: user.providerId,
  };

  return Response.json(
    { ok: true, actor },
    { headers: { "Set-Cookie": sessionSetCookie(signSession(actor)) } },
  );
}
