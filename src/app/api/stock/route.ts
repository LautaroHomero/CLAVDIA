import { createItem, stockOverview } from "@/lib/domain/stock";
import { actorOr401, bodyOf, respond } from "./_http";

/** Stock del consultorio activo: productos con lotes, bajo stock y vencimientos. */
export async function GET(req: Request) {
  const actor = await actorOr401(req);
  if (actor instanceof Response) return actor;
  return respond(await stockOverview(actor));
}

/** Alta de producto: `{ name, unit?, category?, minQuantity? }`. */
export async function POST(req: Request) {
  const actor = await actorOr401(req);
  if (actor instanceof Response) return actor;
  const b = await bodyOf<{ name: string; unit: string; category: string; minQuantity: number }>(req);
  return respond(await createItem(actor, { name: b.name ?? "", unit: b.unit, category: b.category, minQuantity: b.minQuantity }));
}
