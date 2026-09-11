import { actorFromRequest } from "@/lib/auth/actor";
import {
  addMembership,
  createProfessional,
  createUser,
  getUserByDni,
  providerNameTakenInOrg,
} from "@/lib/db/repo";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const phoneOk = (s: string) => s.replace(/\D/g, "").length >= 8;

/**
 * Add a team member to the caller's active organization. Allowed for users who
 * can administer the org (secretaría, or the org's founder).
 *
 * Identity is anchored on DNI:
 *  - Already in the system → linked to this org, no data re-entry (DNI is enough).
 *  - New → account created from name + email + phone; the person sets their PIN
 *    the first time through "Olvidé mi PIN". Staff never hands out PINs.
 */
export async function POST(req: Request) {
  const actor = await actorFromRequest(req);
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
    dni?: string;
    name?: string;
    email?: string;
    phone?: string;
    specialty?: string;
    roomLabel?: string;
  };
  const role = body.role === "recepcion" ? "recepcion" : "medico";
  const dni = body.dni?.trim();
  if (!dni) {
    return Response.json({ ok: false, error: "Indicá el DNI." }, { status: 400 });
  }

  const orgId = actor.activeOrg.id;
  const existing = await getUserByDni(dni);

  // ── Secretaría ────────────────────────────────────────────────────────────
  if (role === "recepcion") {
    if (existing) {
      await addMembership({ userId: existing.id, organizationId: orgId, role: "recepcion", canAdmin: true });
      return Response.json({
        ok: true,
        role: "recepcion",
        member: { name: existing.name, email: existing.email },
        reusedUser: true,
        message: `${existing.name} ya estaba en el sistema; ahora también administra este consultorio.`,
      });
    }
    const name = body.name?.trim();
    const email = body.email?.trim().toLowerCase();
    const phone = body.phone?.trim();
    if (!name || !email || !phone) {
      return Response.json(
        { ok: false, error: "Persona nueva: completá nombre, email y teléfono." },
        { status: 400 },
      );
    }
    if (!EMAIL_RE.test(email)) {
      return Response.json({ ok: false, error: "El email no parece válido." }, { status: 400 });
    }
    if (!phoneOk(phone)) {
      return Response.json({ ok: false, error: "El teléfono no parece válido." }, { status: 400 });
    }
    const userId = (
      await createUser({
        name,
        email,
        role: "recepcion",
        pinHash: "",
        pinSalt: "",
        dni,
        phone,
      })
    ).id;
    await addMembership({ userId, organizationId: orgId, role: "recepcion", canAdmin: true });
    return Response.json({
      ok: true,
      role: "recepcion",
      member: { name, email },
      reusedUser: false,
      message: `${name} entra con su DNI o email y "Olvidé mi PIN" para elegir su PIN (secretaría administrativa).`,
    });
  }

  // ── Profesional ───────────────────────────────────────────────────────────
  if (existing) {
    const { provider } = await createProfessional({
      organizationId: orgId,
      name: existing.name,
      email: existing.email,
      dni: existing.dni || dni,
      phone: existing.phone,
      specialty: body.specialty?.trim() || "A confirmar",
      roomLabel: body.roomLabel?.trim() || "Consultorio",
    });
    return Response.json({
      ok: true,
      role: "medico",
      provider: { id: provider.id, name: provider.name, specialty: provider.specialty, roomLabel: provider.roomLabel },
      reusedUser: true,
      message: `${existing.name} ya estaba en el sistema; lo/la sumamos con agenda propia.`,
    });
  }

  const name = body.name?.trim();
  const email = body.email?.trim().toLowerCase();
  const phone = body.phone?.trim();
  const specialty = body.specialty?.trim();
  if (!name || !email || !phone) {
    return Response.json(
      { ok: false, error: "Persona nueva: completá nombre, email y teléfono." },
      { status: 400 },
    );
  }
  if (!EMAIL_RE.test(email)) {
    return Response.json({ ok: false, error: "El email no parece válido." }, { status: 400 });
  }
  if (!phoneOk(phone)) {
    return Response.json({ ok: false, error: "El teléfono no parece válido." }, { status: 400 });
  }
  if (!specialty) {
    return Response.json({ ok: false, error: "Elegí el tipo de profesional." }, { status: 400 });
  }
  if (await providerNameTakenInOrg(orgId, name)) {
    return Response.json(
      { ok: false, error: `Ya hay un profesional llamado "${name}" en este consultorio.` },
      { status: 409 },
    );
  }
  const { provider } = await createProfessional({
    organizationId: orgId,
    name,
    email,
    dni,
    phone,
    specialty,
    roomLabel: body.roomLabel?.trim() || "Consultorio",
  });
  return Response.json({
    ok: true,
    role: "medico",
    provider: { id: provider.id, name: provider.name, specialty: provider.specialty, roomLabel: provider.roomLabel },
    reusedUser: false,
    message: `${provider.name} (${provider.specialty}) entra con su DNI o email y "Olvidé mi PIN" para elegir su PIN.`,
  });
}
