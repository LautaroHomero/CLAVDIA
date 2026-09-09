import { getUserWithPin } from "@/lib/db/repo";
import { verifyPin } from "@/lib/auth/pin";
import { sessionSetCookie, signSession } from "@/lib/auth/session";
import type { Actor } from "@/lib/domain/types";

export async function POST(req: Request) {
  const { userId, pin } = (await req.json()) as { userId?: string; pin?: string };
  if (!userId || !pin) {
    return Response.json({ ok: false, error: "Falta usuario o PIN." }, { status: 400 });
  }

  const user = getUserWithPin(userId);
  if (!user || !verifyPin(pin, user.pinHash, user.pinSalt)) {
    return Response.json({ ok: false, error: "Usuario o PIN incorrecto." }, { status: 401 });
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
