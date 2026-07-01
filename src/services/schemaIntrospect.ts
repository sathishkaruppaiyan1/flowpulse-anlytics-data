import { withClientConnection } from "./clientDb.js";
import { controlQuery } from "../db/control.js";
import { getProjectConnString } from "./projectStore.js";

export interface ColumnInfo {
  column: string;
  type: string;
}
export interface TableInfo {
  schema: string;
  table: string;
  columns: ColumnInfo[];
}

/** Introspect user tables from a client DB (public + custom schemas only). */
export async function introspectSchema(
  connectionString: string
): Promise<TableInfo[]> {
  return withClientConnection(connectionString, async (client) => {
    const { rows } = await client.query<{
      table_schema: string;
      table_name: string;
      column_name: string;
      data_type: string;
    }>(
      `select table_schema, table_name, column_name, data_type
       from information_schema.columns
       where table_schema not in
         ('pg_catalog','information_schema','auth','storage','realtime',
          'vault','extensions','graphql','graphql_public','supabase_functions')
       order by table_schema, table_name, ordinal_position`
    );

    const map = new Map<string, TableInfo>();
    for (const r of rows) {
      const key = `${r.table_schema}.${r.table_name}`;
      if (!map.has(key)) {
        map.set(key, {
          schema: r.table_schema,
          table: r.table_name,
          columns: [],
        });
      }
      map.get(key)!.columns.push({ column: r.column_name, type: r.data_type });
    }
    return [...map.values()];
  });
}

/** Return cached schema for a project, refreshing if missing or stale (>1h). */
export async function getSchema(
  projectId: number,
  tenantId: number,
  maxAgeMs = 60 * 60 * 1000
): Promise<TableInfo[]> {
  const cached = await controlQuery<{ tables_json: TableInfo[]; refreshed_at: string }>(
    `select tables_json, refreshed_at from schema_cache where project_id = $1`,
    [projectId]
  );
  if (cached.rows[0]) {
    const age = Date.now() - new Date(cached.rows[0].refreshed_at).getTime();
    if (age < maxAgeMs) return cached.rows[0].tables_json;
  }
  return refreshSchema(projectId, tenantId);
}

export async function refreshSchema(
  projectId: number,
  tenantId: number
): Promise<TableInfo[]> {
  const conn = await getProjectConnString(projectId, tenantId);
  if (!conn) throw new Error("Project connection not found");
  const tables = await introspectSchema(conn);
  await controlQuery(
    `insert into schema_cache (project_id, tables_json, refreshed_at)
     values ($1, $2, now())
     on conflict (project_id)
       do update set tables_json = excluded.tables_json, refreshed_at = now()`,
    [projectId, JSON.stringify(tables)]
  );
  return tables;
}

/** Compact text representation of the schema for the LLM prompt. */
export function schemaToPrompt(tables: TableInfo[]): string {
  if (tables.length === 0) return "(no user tables found)";
  return tables
    .map(
      (t) =>
        `${t.schema}.${t.table}(${t.columns
          .map((c) => `${c.column} ${c.type}`)
          .join(", ")})`
    )
    .join("\n");
}
