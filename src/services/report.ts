import type { QueryOutput } from "./executor.js";

/** Format a cell value for display: clean up dates, leave everything else. */
function fmtVal(v: unknown): string {
  if (v instanceof Date) {
    const iso = v.toISOString(); // 2026-05-01T00:00:00.000Z
    const [d, t] = iso.split("T");
    return t.startsWith("00:00:00") ? d : `${d} ${t.slice(0, 5)}`;
  }
  return String(v ?? "");
}

/** Render a small result set as a fixed-width text table for Telegram (HTML <pre>). */
export function renderTable(output: QueryOutput, maxRows = 15): string {
  if (output.rows.length === 0) return "(no rows)";

  const cols = output.columns;
  const rows = output.rows.slice(0, maxRows);

  const widths = cols.map((c) =>
    Math.max(
      c.length,
      ...rows.map((r) => fmtVal(r[c]).length)
    )
  );

  const fmtRow = (vals: string[]) =>
    vals.map((v, i) => v.padEnd(widths[i])).join("  ");

  const header = fmtRow(cols);
  const sep = widths.map((w) => "-".repeat(w)).join("  ");
  const body = rows
    .map((r) => fmtRow(cols.map((c) => fmtVal(r[c]))))
    .join("\n");

  let out = `${header}\n${sep}\n${body}`;
  if (output.rows.length > maxRows) {
    out += `\n... ${output.rows.length - maxRows} more row(s)`;
  }
  return out;
}

/**
 * Render a result set as plain text (no HTML/code block, so Telegram shows no
 * "copy code" button). One row per line; exact values, not summarized.
 */
export function renderValues(output: QueryOutput, maxRows = 30): string {
  if (output.rows.length === 0) return "(no results)";

  const cols = output.columns;
  const rows = output.rows.slice(0, maxRows);

  const lines = rows.map((r) => {
    if (cols.length === 1) return fmtVal(r[cols[0]]);
    return cols.map((c) => `${c}: ${fmtVal(r[c])}`).join(", ");
  });

  let out = lines.join("\n");
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
