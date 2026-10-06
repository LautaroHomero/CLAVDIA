import type { StaffRole } from "@/lib/domain/types";
import { updateStockSettings } from "@/lib/domain/stock";
import { actorOr401, bodyOf, respond } from "../_http";

/** Quién puede modificar stock y con cuántos días de aviso de vencimiento. Solo admin: `{ roles?, expiryDays? }`. */
export async function PATCH(req: Request) {
  const actor = await actorOr401(req);
  if (actor instanceof Response) return actor;
  const b = await bodyOf<{ roles: StaffRole[]; expiryDays: number }>(req);
  return respond(await updateStockSettings(actor, b));
}
