import { stockHistory } from "@/lib/domain/stock";
import { actorOr401, respond } from "../_http";

/** Historial de movimientos del consultorio: `?itemId=` filtra por producto, `?limit=` (máx. 500). */
export async function GET(req: Request) {
  const actor = await actorOr401(req);
  if (actor instanceof Response) return actor;
  const url = new URL(req.url);
  const limit = Number(url.searchParams.get("limit") ?? 100);
  return respond(await stockHistory(actor, url.searchParams.get("itemId") ?? undefined, Number.isFinite(limit) ? limit : 100));
}
