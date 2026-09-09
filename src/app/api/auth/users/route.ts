import { listUsers } from "@/lib/db/repo";

/** Users available in the login picker (no secrets). */
export async function GET() {
  return Response.json({
    users: listUsers().map((u) => ({ id: u.id, name: u.name, role: u.role })),
  });
}
