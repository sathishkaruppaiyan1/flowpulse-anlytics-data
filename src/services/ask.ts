import { config } from "../config.js";
import {
  getActiveProject,
  getProjectConnString,
  logQuery,
  type Tenant,
} from "./projectStore.js";
import { getSchema, schemaToPrompt } from "./schemaIntrospect.js";
import { generateSql, summarizeResults } from "./nl2sql.js";
import { guardSql } from "./sqlGuard.js";
import { runReadOnly, type QueryOutput } from "./executor.js";

export interface AskResult {
  ok: boolean;
  answer?: string;
  sql?: string;
  output?: QueryOutput;
  error?: string;
}

/**
 * Full question pipeline:
 * question -> active project -> schema -> LLM SQL -> guard -> execute -> summarize -> log
 */
export async function ask(tenant: Tenant, question: string): Promise<AskResult> {
  const project = await getActiveProject(tenant.id);
  if (!project) {
    return {
      ok: false,
      error: "No active project. Use /connect to add one, then /use to select it.",
    };
  }

  let sql: string | null = null;
  try {
    const tables = await getSchema(project.id, tenant.id);
    const schemaText = schemaToPrompt(tables);

    const rawSql = await generateSql(question, schemaText);
    if (rawSql.includes("CANNOT_ANSWER")) {
      await logQuery({
        tenantId: tenant.id,
        projectId: project.id,
        question,
        sql: null,
        rowCount: null,
        success: false,
        error: "CANNOT_ANSWER",
      });
      return {
        ok: false,
        error:
          "I couldn't map that to your data. Try rephrasing, or check the table names with /schema.",
      };
    }

    const guard = guardSql(rawSql, config.queryRowLimit);
    if (!guard.ok || !guard.sql) {
      await logQuery({
        tenantId: tenant.id,
        projectId: project.id,
        question,
        sql: rawSql,
        rowCount: null,
        success: false,
        error: guard.reason,
      });
      return { ok: false, error: `Query rejected: ${guard.reason}`, sql: rawSql };
    }
    sql = guard.sql;

    const conn = await getProjectConnString(project.id, tenant.id);
    if (!conn) return { ok: false, error: "Project connection missing." };

    const output = await runReadOnly(conn, sql);
    const answer = await summarizeResults(question, output);

    await logQuery({
      tenantId: tenant.id,
      projectId: project.id,
      question,
      sql,
      rowCount: output.rowCount,
      success: true,
    });

    return { ok: true, answer, sql, output };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await logQuery({
      tenantId: tenant.id,
      projectId: project.id,
      question,
      sql,
      rowCount: null,
      success: false,
      error: message,
    });
    return { ok: false, error: message, sql: sql ?? undefined };
  }
}
