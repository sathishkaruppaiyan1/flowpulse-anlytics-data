import pg from "pg";
import { config } from "../config.js";

// Connection pool to the CONTROL-PLANE database (your own DB).
export const controlPool = new pg.Pool({
  connectionString: config.controlDbUrl,
  max: 10,
  idleTimeoutMillis: 30_000,
});

controlPool.on("error", (err) => {
  console.error("[control-db] unexpected pool error:", err.message);
});

export async function controlQuery<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: unknown[]
): Promise<pg.QueryResult<T>> {
  return controlPool.query<T>(text, params as any[]);
}
