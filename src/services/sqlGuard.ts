// SQL safety validation. Defense-in-depth alongside the read-only DB role.
// Goal: only allow a single read-only SELECT/WITH query, and enforce a LIMIT.

const FORBIDDEN = [
  "insert",
  "update",
  "delete",
  "drop",
  "alter",
  "create",
  "truncate",
  "grant",
  "revoke",
  "comment",
  "copy",
  "vacuum",
  "call",
  "do",
  "merge",
  "pg_sleep",
];

export interface GuardResult {
  ok: boolean;
  sql?: string;
  reason?: string;
}

/** Strip SQL comments so they can't hide forbidden statements. */
function stripComments(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .trim();
}

export function guardSql(rawSql: string, rowLimit: number): GuardResult {
  let sql = stripComments(rawSql);

  // Remove a single trailing semicolon, then reject if any remain (multi-stmt).
  sql = sql.replace(/;\s*$/, "");
  if (sql.includes(";")) {
    return { ok: false, reason: "Multiple statements are not allowed." };
  }

  const lower = sql.toLowerCase();

  if (!/^\s*(select|with)\b/.test(lower)) {
    return { ok: false, reason: "Only SELECT queries are allowed." };
  }

  for (const word of FORBIDDEN) {
    // word-boundary match to avoid false positives inside identifiers
    if (new RegExp(`\\b${word}\\b`, "i").test(lower)) {
      return { ok: false, reason: `Disallowed keyword: ${word}` };
    }
  }

  // Enforce a LIMIT to protect the client's DB and the bot.
  if (!/\blimit\s+\d+/i.test(lower)) {
    sql = `${sql}\nLIMIT ${rowLimit}`;
  }

  return { ok: true, sql };
}
