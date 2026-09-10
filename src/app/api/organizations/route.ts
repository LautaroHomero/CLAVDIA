import {
  addMembership,
  createOrganization,
  createProfessional,
  createUser,
  listOrganizations,
  organizationNameTaken,
  userEmailTaken,
} from "@/lib/db/repo";
import { hashPin } from "@/lib/auth/pin";
import { hydrateActor } from "@/lib/auth/actor";
import { sessionSetCookie, signSession, type SessionClaims } from "@/lib/auth/session";
import type { StaffRole } from "@/lib/domain/types";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Public list of organizations (for the patient's "elegí dónde atenderte"). */
export async function GET() {
  return Response.json({
    organizations: listOrganizations().map((o) => ({
      id: o.id,
      name: o.name,
      address: o.address,
      city: o.city,
    })),
  });
}

/**
 * Self-serve organization onboarding. Creates the org + its founding user and
 * logs them in. The founder picks their own role:
 *  - `recepcion`: a secretaría administrativa account.
 *  - `medico`: a professional account (with agenda) that ALSO keeps admin rights,
 *    so a one-person practice can still onboard more professionals.
 */
export async function POST(req: Request) {
  const body = (await req.json()) as {
    orgName?: string;
    address?: string;
    city?: string;
    phone?: string;
    hours?: string;
    founderName?: string;
    founderEmail?: string;
    founderRole?: "recepcion" | "medico";
    specialty?: string;
    roomLabel?: string;
    pin?: string;
  };

  const orgName = body.orgName?.trim();
  const founderName = body.founderName?.trim();
  const founderEmail = body.founderEmail?.trim().toLowerCase();
  const founderRole: StaffRole = body.founderRole === "medico" ? "medico" : "recepcion";
  const pin = body.pin?.trim();

  if (!orgName || !founderName || !founderEmail || !pin) {
    return Response.json(
      { ok: false, error: "Completá el consultorio, tu nombre, tu email y un PIN." },
      { status: 400 },
    );
  }
  if (!EMAIL_RE.test(founderEmail)) {
    return Response.json({ ok: false, error: "El email no parece válido." }, { status: 400 });
  }
  if (!/^\d{4}$/.test(pin)) {
    return Response.json({ ok: false, error: "El PIN tiene que ser de 4 dígitos." }, { status: 400 });
  }
  if (founderRole === "medico" && !body.specialty?.trim()) {
    return Response.json(
      { ok: false, error: "Indicá tu especialidad o profesión." },
      { status: 400 },
    );
  }
  if (organizationNameTaken(orgName)) {
    return Response.json({ ok: false, error: "Ya existe una organización con ese nombre." }, { status: 409 });
  }
  if (userEmailTaken(founderEmail)) {
    return Response.json(
      { ok: false, error: "Ya hay una cuenta con ese email. Iniciá sesión." },
      { status: 409 },
    );
  }

  const org = createOrganization({
    name: orgName,
    address: body.address,
    city: body.city,
    phone: body.phone,
    hours: body.hours,
  });
  const { hash, salt } = hashPin(pin);

  let userId: string;
  if (founderRole === "medico") {
    const res = createProfessional({
      organizationId: org.id,
      name: founderName,
      email: founderEmail,
      specialty: body.specialty!.trim(),
      roomLabel: body.roomLabel?.trim() || "Consultorio 1",
      pinHash: hash,
      pinSalt: salt,
      canAdmin: true, // founder keeps admin rights even as a professional
    });
    userId = res.userId;
  } else {
    const user = createUser({
      name: founderName,
      email: founderEmail,
      role: "recepcion",
      pinHash: hash,
      pinSalt: salt,
    });
    addMembership({ userId: user.id, organizationId: org.id, role: "recepcion", canAdmin: true });
    userId = user.id;
  }

  const claims: SessionClaims = { userId, role: founderRole, activeOrgId: org.id };
  return Response.json(
    { ok: true, actor: hydrateActor(claims), organization: { id: org.id, name: org.name } },
    { headers: { "Set-Cookie": sessionSetCookie(signSession(claims)) } },
  );
}
