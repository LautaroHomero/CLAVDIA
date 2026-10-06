import { writeOffLot } from "@/lib/domain/stock";
import { actorOr401, bodyOf, respond } from "../../../_http";

/** Da de baja un lote entero: `{ reason?: "vencimiento" | "perdida" | "ajuste", note? }`. */
export async function POST(req: Request, ctx: { params: Promise<{ lotId: string }> }) {
  const actor = await actorOr401(req);
  if (actor instanceof Response) return actor;
  const b = await bodyOf<{ reason: "vencimiento" | "perdida" | "ajuste"; note: string }>(req);
  return respond(await writeOffLot(actor, (await ctx.params).lotId, b.reason, b.note));
}
