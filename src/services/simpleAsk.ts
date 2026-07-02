import { config } from "../config.js";
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
 * Simple-mode pipeline: no control-plane DB. Given a connection string and the
 * schema text, answer a natural-language question directly.
 * question -> LLM SQL -> guard -> execute -> summarize
 */
export async function simpleAsk(
  connectionString: string,
  schemaText: string,
  question: string
): Promise<AskResult> {
  try {
    const rawSql = await generateSql(question, schemaText);
    if (rawSql.includes("CANNOT_ANSWER")) {
      return {
        ok: false,
        error:
          "I couldn't map that to your data. Try rephrasing, or check the tables with /schema.",
      };
    }

    console.log("[ask] generated SQL:", rawSql.replace(/\s+/g, " ").trim());

    const guard = guardSql(rawSql, config.queryRowLimit);
    if (!guard.ok || !guard.sql) {
      return { ok: false, error: `Query rejected: ${guard.reason}`, sql: rawSql };
    }

    const output = await runReadOnly(connectionString, guard.sql);
    const answer = await summarizeResults(question, output);
    return { ok: true, answer, sql: guard.sql, output };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}
