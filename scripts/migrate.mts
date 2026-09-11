import { config } from "dotenv";
import postgres from "postgres";
import { migrate } from "../src/lib/db/migrate";

// `dotenv/config` only reads `.env`; this project (like Next.js) keeps real
// values in `.env.local`. Load both, `.env.local` taking precedence.
config({ path: ".env" });
config({ path: ".env.local", override: true });

const url = process.env.DATABASE_URL_DIRECT ?? process.env.DATABASE_URL;
if (!url) {
  console.error("Falta DATABASE_URL_DIRECT (o DATABASE_URL). Ver .env.example.");
  process.exit(1);
}

const sql = postgres(url, { prepare: false, max: 1, ssl: "require" });
try {
  const ran = await migrate(sql);
  console.log(ran.length ? `Migraciones aplicadas: ${ran.join(", ")}` : "Nada pendiente.");
} finally {
  await sql.end();
}
