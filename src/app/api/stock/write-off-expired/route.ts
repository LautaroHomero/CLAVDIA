import { writeOffExpired } from "@/lib/domain/stock";
import { actorOr401, bodyOf, respond } from "../_http";

/** Da de baja todos los lotes vencidos (o los de un producto: `{ itemId? }`). */
export async function POST(req: Request) {
  const actor = await actorOr401(req);
  if (actor instanceof Response) return actor;
  const b = await bodyOf<{ itemId: string }>(req);
  return respond(await writeOffExpired(actor, b.itemId));
}
