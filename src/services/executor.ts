import { withClientConnection } from "./clientDb.js";

export interface QueryOutput {
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
}

/** Run a validated read-only SQL query against a client's database. */
export async function runReadOnly(
  connectionString: string,
  sql: string
): Promise<QueryOutput> {
  return withClientConnection(connectionString, async (client) => {
    const result = await client.query(sql);
    return {
      columns: result.fields.map((f) => f.name),
      rows: result.rows,
      rowCount: result.rowCount ?? result.rows.length,
    };
  });
}
