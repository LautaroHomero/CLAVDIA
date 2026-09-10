import { actorFromRequest } from "@/lib/auth/actor";
import { searchPatients } from "@/lib/db/repo";

/**
 * Staff-only patient list for the "Sistema" view. With no `q` it returns every
 * patient of the active organization; with `q` it filters by name, DNI, email,
 * phone or id.
 */
export async function GET(req: Request) {
  const actor = actorFromRequest(req);
  if (!actor) return Response.json({ error: "No autenticado." }, { status: 401 });
  if (actor.role === "paciente") {
    return Response.json({ error: "Solo personal del consultorio." }, { status: 403 });
  }
  const orgId = actor.activeOrg?.id;
  if (!orgId) return Response.json({ error: "Sin organización activa." }, { status: 400 });

  const q = (new URL(req.url).searchParams.get("q") ?? "").trim();
  const all = searchPatients(orgId, q);
  const matches = all.slice(0, 200).map((p) => ({
    patientId: p.id,
    fullName: p.fullName,
    dni: p.dni,
    phone: p.phone,
    email: p.email,
    coverage: p.coverage,
  }));
  return Response.json({ count: all.length, shown: matches.length, matches });
}
