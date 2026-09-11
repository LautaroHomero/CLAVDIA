import "dotenv/config";
import postgres from "postgres";
import { seedIfEmpty } from "../src/lib/db/seed";

const url = process.env.DATABASE_URL_DIRECT ?? process.env.DATABASE_URL;
if (!url) {
  console.error("Falta DATABASE_URL_DIRECT (o DATABASE_URL). Ver .env.example.");
  process.exit(1);
}

const sql = postgres(url, { prepare: false, max: 1, ssl: "require" });
try {
  const seeded = await seedIfEmpty(sql);
  console.log(seeded ? "Seed aplicado." : "La base ya tenía datos — no se tocó.");
} finally {
  await sql.end();
}
