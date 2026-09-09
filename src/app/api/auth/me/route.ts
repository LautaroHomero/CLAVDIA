import { actorFromRequest } from "@/lib/auth/session";

export async function GET(req: Request) {
  const actor = actorFromRequest(req);
  if (!actor) return Response.json({ actor: null }, { status: 401 });
  return Response.json({ actor });
}
