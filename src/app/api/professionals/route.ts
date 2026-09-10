import { actorFromRequest } from "@/lib/auth/actor";
import { hashPin } from "@/lib/auth/pin";
import {
  addMembership,
  createProfessional,
  createUser,
  getUserByEmail,
  providerNameTakenInOrg,
  userEmailTaken,
} from "@/lib/db/repo";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Add a team member to the caller's active organization. Allowed for users who
 * can administer the org (secretaría, or the org's founder).
 *
 * `role: "recepcion"` → a secretaría administrativa account (no agenda).
 * `role: "medico"` (default) → a professional, with `specialty` and an agenda.
 * A person who already has an account (same email) is reused and just linked to
 * this organization; their existing PIN stays.
 */
export async function POST(req: Request) {
  const actor = actorFromRequest(req);
  if (!actor || actor.role === "paciente" || !actor.activeOrg) {
    return Response.json({ ok: false, error: "No autorizado." }, { status: 401 });
  }
  if (!actor.activeOrg.canAdmin) {
    return Response.json(
      { ok: false, error: "Solo la secretaría administrativa puede dar de alta al equipo." },
      { status: 403 },
    );
  }

  const body = (await req.json()) as {
    role?: "recepcion" | "medico";
    name?: string;
    email?: string;
    specialty?: string;
    roomLabel?: string;
    pin?: string;
  };
  const role = body.role === "recepcion" ? "recepcion" : "medico";
  const name = body.name?.trim();
  const email = body.email?.trim().toLowerCase();
  const specialty = body.specialty?.trim();
  const pin = body.pin?.trim();

  if (!name || !email || !pin) {
    return Response.json(
      { ok: false, error: "Completá nombre, email y un PIN de 4 dígitos." },
      { status: 400 },
    );
  }
  if (!EMAIL_RE.test(email)) {
    return Response.json({ ok: false, error: "El email no parece válido." }, { status: 400 });
  }
  if (!/^\d{4}$/.test(pin)) {
    return Response.json({ ok: false, error: "El PIN tiene que ser de 4 dígitos." }, { status: 400 });
  }
  if (role === "medico" && !specialty) {
    return Response.json({ ok: false, error: "Elegí el tipo de profesional." }, { status: 400 });
  }

  const orgId = actor.activeOrg.id;

  if (role === "recepcion") {
    const existing = getUserByEmail(email);
    if (existing && existing.role !== "recepcion") {
      return Response.json(
        { ok: false, error: "Ya hay una cuenta con ese email y otro rol." },
        { status: 409 },
      );
    }
    const { hash, salt } = hashPin(pin);
    const userId = existing?.id ?? createUser({ name, email, role: "recepcion", pinHash: hash, pinSalt: salt }).id;
    addMembership({ userId, organizationId: orgId, role: "recepcion", canAdmin: true });
    return Response.json({
      ok: true,
      role: "recepcion",
      member: { name, email },
      reusedUser: Boolean(existing),
      message: existing
        ? `${name} ya tenía cuenta; ahora también administra este consultorio.`
        : `${name} puede entrar con ${email} y el PIN que le diste (secretaría administrativa).`,
    });
  }

  // role === "medico"
  if (providerNameTakenInOrg(orgId, name)) {
    return Response.json(
      { ok: false, error: `Ya hay un profesional llamado "${name}" en este consultorio.` },
      { status: 409 },
    );
  }
  const reused = userEmailTaken(email);
  const { hash, salt } = hashPin(pin);
  const { provider, reusedUser } = createProfessional({
    organizationId: orgId,
    name,
    email,
    specialty: specialty!,
    roomLabel: body.roomLabel?.trim() || "Consultorio",
    pinHash: hash,
    pinSalt: salt,
  });

  return Response.json({
    ok: true,
    role: "medico",
    provider: { id: provider.id, name: provider.name, specialty: provider.specialty, roomLabel: provider.roomLabel },
    reusedUser: reusedUser || reused,
    message: reusedUser
      ? `${provider.name} ya tenía cuenta; lo/la sumamos con agenda propia (su PIN sigue siendo el de siempre).`
      : `${provider.name} (${provider.specialty}) puede entrar con ${email} y el PIN que le diste.`,
  });
}
