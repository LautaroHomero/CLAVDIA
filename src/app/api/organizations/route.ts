import {
  addMembership,
  createOrganization,
  createUser,
  listOrganizations,
  organizationNameTaken,
  userNameTaken,
} from "@/lib/db/repo";
import { hashPin } from "@/lib/auth/pin";
import { hydrateActor } from "@/lib/auth/actor";
import { sessionSetCookie, signSession } from "@/lib/auth/session";

/** Public list of organizations (for the patient's "elegí dónde atenderte"). */
export async function GET() {
  return Response.json({
    organizations: listOrganizations().map((o) => ({ id: o.id, name: o.name, address: o.address })),
  });
}

/**
 * Self-serve organization sign-up: creates the org + its first reception user,
 * and logs that user in.
 */
export async function POST(req: Request) {
  const body = (await req.json()) as {
    orgName?: string;
    address?: string;
    phone?: string;
    receptionName?: string;
    pin?: string;
  };
  const orgName = body.orgName?.trim();
  const receptionName = body.receptionName?.trim();
  const pin = body.pin?.trim();

  if (!orgName || !receptionName || !pin || !/^\d{4}$/.test(pin)) {
    return Response.json(
      { ok: false, error: "Completá el nombre del consultorio, tu nombre y un PIN de 4 dígitos." },
      { status: 400 },
    );
  }
  if (organizationNameTaken(orgName)) {
    return Response.json({ ok: false, error: "Ya existe una organización con ese nombre." }, { status: 409 });
  }
  if (userNameTaken(receptionName)) {
    return Response.json(
      { ok: false, error: "Ya existe un usuario con ese nombre. Probá con otro." },
      { status: 409 },
    );
  }

  const org = createOrganization({ name: orgName, address: body.address, phone: body.phone });
  const { hash, salt } = hashPin(pin);
  const user = createUser({ name: receptionName, role: "recepcion", pinHash: hash, pinSalt: salt });
  addMembership({ userId: user.id, organizationId: org.id, role: "recepcion" });

  const claims = { userId: user.id, role: "recepcion" as const, activeOrgId: org.id };
  return Response.json(
    { ok: true, actor: hydrateActor(claims), organization: { id: org.id, name: org.name } },
    { headers: { "Set-Cookie": sessionSetCookie(signSession(claims)) } },
  );
}
