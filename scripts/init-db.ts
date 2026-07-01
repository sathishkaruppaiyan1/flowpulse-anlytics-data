// Initializes the control-plane database by running db/control-schema.sql.
// Usage: npm run db:init
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import pg from "pg";
import "dotenv/config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const url = process.env.CONTROL_DB_URL;
  if (!url) throw new Error("CONTROL_DB_URL not set (see .env.example)");

  const sqlPath = path.join(__dirname, "..", "db", "control-schema.sql");
  const sql = await readFile(sqlPath, "utf8");

  const pool = new pg.Pool({ connectionString: url });
  try {
    await pool.query(sql);
    console.log("Control-plane schema applied.");
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error("init-db failed:", e.message);
  process.exit(1);
});
