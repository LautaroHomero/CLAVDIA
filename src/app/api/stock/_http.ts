import { actorFromRequest } from "@/lib/auth/actor";
import type { Result } from "@/lib/domain/stock";
import type { Actor } from "@/lib/domain/types";

/** Helpers de los endpoints de stock: la autorización de fondo vive en `domain/stock.ts`. */
export async function actorOr401(req: Request): Promise<Actor | Response> {
  const actor = await actorFromRequest(req);
  return actor ?? Response.json({ ok: false, error: "No autenticado." }, { status: 401 });
}

export function respond<T extends object>(r: Result<T>): Response {
  return r.ok ? Response.json(r) : Response.json({ ok: false, error: r.error }, { status: r.status });
}

export async function bodyOf<T>(req: Request): Promise<Partial<T>> {
  return ((await req.json().catch(() => ({}))) ?? {}) as Partial<T>;
}
