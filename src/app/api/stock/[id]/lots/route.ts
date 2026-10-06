import { addStock } from "@/lib/domain/stock";
import { actorOr401, bodyOf, respond } from "../../_http";

/** Ingreso de un lote: `{ quantity, expiresOn?, lotCode?, note? }`. `expiresOn`: DD/MM/AAAA, MM/AAAA o AAAA-MM-DD. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const actor = await actorOr401(req);
  if (actor instanceof Response) return actor;
  const b = await bodyOf<{ quantity: number; expiresOn: string; lotCode: string; note: string }>(req);
  return respond(await addStock(actor, { itemId: (await ctx.params).id, quantity: b.quantity as number, expiresOn: b.expiresOn, lotCode: b.lotCode, note: b.note }));
}
