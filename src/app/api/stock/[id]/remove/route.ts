import { removeStock } from "@/lib/domain/stock";
import { actorOr401, bodyOf, respond } from "../../_http";

/** Baja por FEFO: `{ quantity, reason?: "uso" | "perdida" | "ajuste", note?, appointmentId?, consultationId? }`. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const actor = await actorOr401(req);
  if (actor instanceof Response) return actor;
  const b = await bodyOf<{
    quantity: number;
    reason: "uso" | "perdida" | "ajuste";
    note: string;
    appointmentId: string;
    consultationId: string;
  }>(req);
  return respond(
    await removeStock(actor, {
      itemId: (await ctx.params).id,
      quantity: b.quantity as number,
      reason: b.reason,
      note: b.note,
      appointmentId: b.appointmentId,
      consultationId: b.consultationId,
    }),
  );
}
