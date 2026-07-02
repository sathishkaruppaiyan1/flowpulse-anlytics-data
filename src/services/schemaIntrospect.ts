import { withClientConnection } from "./clientDb.js";
import { controlQuery } from "../db/control.js";
import { getProjectConnString } from "./projectStore.js";

export interface ColumnInfo {
  column: string;
  type: string;
  /** For json/jsonb columns: top-level keys found by sampling real rows. */
  jsonKeys?: string[];
  /** Whether the sampled json value is an array of objects or a single object. */
  jsonContainer?: "array" | "object";
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

    const tables = [...map.values()];

    // Sample json/jsonb columns so the LLM knows what's *inside* the blob.
    // Without this it invents conventional columns (e.g. order_items.quantity).
    for (const t of tables) {
      for (const col of t.columns) {
        if (col.type !== "jsonb" && col.type !== "json") continue;
        try {
          const rel = `${quoteIdent(t.schema)}.${quoteIdent(t.table)}`;
          const c = quoteIdent(col.column);

          const typeRes = await client.query<{ t: string | null }>(
            `select jsonb_typeof(${c}::jsonb) as t
             from ${rel} where ${c} is not null limit 1`
          );
          const container = typeRes.rows[0]?.t;
          if (container !== "array" && container !== "object") continue;

          const sample = `(select ${c}::jsonb as v from ${rel} where ${c} is not null limit 50) a`;
          const keysSql =
            container === "array"
              ? `select distinct jsonb_object_keys(elem) as k
                 from (select jsonb_array_elements(v) as elem from ${sample}) b
                 where jsonb_typeof(elem) = 'object'
                 order by 1 limit 60`
              : `select distinct jsonb_object_keys(v) as k
                 from ${sample}
                 order by 1 limit 60`;
          const keysRes = await client.query<{ k: string }>(keysSql);
          const keys = keysRes.rows.map((r2) => r2.k);
          if (keys.length > 0) {
            col.jsonKeys = keys;
            col.jsonContainer = container;
          }
        } catch (e) {
          // Sampling is best-effort; never let it break introspection.
          if (process.env.DEBUG_JSON_SAMPLE)
            console.error(`[json-sample] ${t.table}.${col.column}:`, (e as Error).message);
        }
      }
    }

    return tables;
  });
}

/** Quote a Postgres identifier for safe interpolation. */
function quoteIdent(id: string): string {
  return `"${id.replace(/"/g, '""')}"`;
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
          .map((c) => {
            if (c.jsonKeys && c.jsonKeys.length > 0) {
              const shape =
                c.jsonContainer === "array"
                  ? "array of objects with keys"
                  : "object with keys";
              return `${c.column} ${c.type} /* ${shape}: ${c.jsonKeys.join(", ")} */`;
            }
            return `${c.column} ${c.type}`;
          })
          .join(", ")})`
    )
    .join("\n");
}
