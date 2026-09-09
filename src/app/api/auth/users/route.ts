import { listUsers } from "@/lib/db/repo";

/**
 * Names shown as login hints. Only staff names are exposed; patients type their
 * own name (and their names should not be listed publicly).
 */
export async function GET() {
  return Response.json({
    users: listUsers()
      .filter((u) => u.role !== "paciente")
      .map((u) => ({ id: u.id, name: u.name, role: u.role })),
  });
}
