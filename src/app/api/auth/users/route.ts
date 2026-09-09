import { listStaffNames } from "@/lib/db/repo";

/** Staff names shown as login hints (patients type their own name). */
export async function GET() {
  return Response.json({ staff: listStaffNames() });
}
