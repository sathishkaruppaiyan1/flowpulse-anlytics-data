import pg from "pg";
import { config } from "../config.js";

/**
 * Opens a short-lived, READ-ONLY connection to a client's database, runs `fn`,
 * and always closes the connection. Every session is forced read-only and
 * given a hard statement timeout as defense-in-depth (on top of the read-only
 * Postgres role the client is asked to create).
 */
export async function withClientConnection<T>(
  connectionString: string,
  fn: (client: pg.PoolClient) => Promise<T>
): Promise<T> {
  const pool = new pg.Pool({
    connectionString,
    max: 1,
    connectionTimeoutMillis: 10_000,
    // Reject self-signed certs leniency: Supabase requires SSL.
    ssl: { rejectUnauthorized: false },
  });
  const client = await pool.connect();
  try {
    await client.query("set session characteristics as transaction read only");
    await client.query(`set statement_timeout = ${config.queryTimeoutMs}`);
    return await fn(client);
  } finally {
    client.release();
    await pool.end();
  }
}
