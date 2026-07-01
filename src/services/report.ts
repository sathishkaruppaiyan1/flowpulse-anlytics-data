import type { QueryOutput } from "./executor.js";

/** Render a small result set as a fixed-width text table for Telegram (HTML <pre>). */
export function renderTable(output: QueryOutput, maxRows = 15): string {
  if (output.rows.length === 0) return "(no rows)";

  const cols = output.columns;
  const rows = output.rows.slice(0, maxRows);

  const widths = cols.map((c) =>
    Math.max(
      c.length,
      ...rows.map((r) => String(r[c] ?? "").length)
    )
  );

  const fmtRow = (vals: string[]) =>
    vals.map((v, i) => v.padEnd(widths[i])).join("  ");

  const header = fmtRow(cols);
  const sep = widths.map((w) => "-".repeat(w)).join("  ");
  const body = rows
    .map((r) => fmtRow(cols.map((c) => String(r[c] ?? ""))))
    .join("\n");

  let out = `${header}\n${sep}\n${body}`;
  if (output.rows.length > maxRows) {
    out += `\n... ${output.rows.length - maxRows} more row(s)`;
  }
  return out;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function asPre(text: string): string {
  return `<pre>${escapeHtml(text)}</pre>`;
}
