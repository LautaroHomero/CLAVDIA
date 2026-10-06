import { editItem } from "@/lib/domain/stock";
import { actorOr401, bodyOf, respond } from "../_http";

/** Edita un producto: `{ name?, unit?, category?, minQuantity?, active? }` (`active: false` lo da de baja). */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const actor = await actorOr401(req);
  if (actor instanceof Response) return actor;
  const b = await bodyOf<{ name: string; unit: string; category: string; minQuantity: number; active: boolean }>(req);
  return respond(await editItem(actor, (await ctx.params).id, b));
}
