// "Complete details" report for a single reseller: a text summary for the chat
// plus a multi-section CSV (summary, status breakdown, top products, order list).
//
// This is a deterministic, code-driven report (not LLM SQL) so the numbers are
// always consistent. Reseller data lives in public.orders.reseller_name /
// public.orders.total; the resellers table is config-only and often empty.

import { withClientConnection } from "./clientDb.js";

export interface ResellerReport {
  found: boolean;
  displayName?: string;
  /** Short summary to show in the chat. */
  summaryText: string;
  /** CSV file contents (UTF-8, BOM-prefixed for Excel). Present only when found. */
  csv?: string;
  filename?: string;
}

// Words that are never part of a reseller's name in a "details" request.
// Includes generic shop/brand words so the same reseller stored under several
// spellings ('Shiny boutique' vs 'Shiny') is matched by its distinctive token.
const FILLERS = new Set([
  "complete", "full", "all", "details", "detail", "report", "reports",
  "reseller", "resellers", "reselling", "give", "get", "show", "send", "me",
  "the", "of", "for", "with", "and", "please", "total", "orders", "order",
  "amount", "amounts", "top", "product", "products", "csv", "pdf", "his", "her",
  "their", "info", "information", "summary", "data", "sales", "value", "values",
  "boutique", "collection", "couture", "lifestyle", "store", "shop", "fashion",
  "fashions", "textiles", "creations", "designs", "studio", "brand", "seller",
]);

/** True when the message is asking for a full/complete reseller report. */
export function isCompleteDetailsRequest(text: string): boolean {
  return /\b(complete|full|all|detailed)\b[\s\w]*\b(details?|report|info(?:rmation)?)\b/i.test(
    text
  ) || /\b(details?|report)\s+(csv|pdf|file)\b/i.test(text);
}

/** Distinctive name tokens (alphanumeric, non-filler) to match a reseller by. */
export function extractResellerTokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !FILLERS.has(w));
}

function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function csvRow(cells: unknown[]): string {
  return cells.map(csvCell).join(",");
}
function inr(v: unknown): string {
  const n = Number(v ?? 0);
  return "₹" + n.toLocaleString("en-IN", { maximumFractionDigits: 2 });
}
function ymd(v: unknown): string {
  if (!v) return "";
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? String(v) : d.toISOString().slice(0, 10);
}

/**
 * Build a complete-details report for the reseller named in `question`.
 * Matches reseller_name by ANDing the distinctive tokens (injection-safe: tokens
 * are [a-z0-9]+). Returns found:false with a helpful summary if no match.
 */
export async function buildResellerReport(
  connectionString: string,
  question: string
): Promise<ResellerReport> {
  const tokens = extractResellerTokens(question);
  if (tokens.length === 0) {
    return {
      found: false,
      summaryText:
        "Which reseller? Try e.g. \"minikki complete details\".",
    };
  }

  // reseller_name lives on public.orders; tokens are safe alphanumerics.
  const where = tokens.map((t) => `o.reseller_name ILIKE '%${t}%'`).join(" AND ");

  return withClientConnection(connectionString, async (client) => {
    const summaryQ = await client.query(
      `select count(*)::int                       as orders,
              coalesce(sum(o.total),0)            as amount,
              coalesce(avg(o.total),0)            as avg_order,
              min(o.created_at)                   as first_order,
              max(o.created_at)                   as last_order
       from public.orders o
       where ${where}`
    );
    const s = summaryQ.rows[0];

    if (!s || Number(s.orders) === 0) {
      // No match — list the actual reseller names to guide the user.
      const names = await client.query(
        `select o.reseller_name as name, count(*)::int as orders
         from public.orders o
         where o.reseller_name is not null
         group by o.reseller_name order by orders desc limit 15`
      );
      const list = names.rows
        .map((r) => `- ${r.name} (${r.orders})`)
        .join("\n");
      return {
        found: false,
        summaryText:
          `I couldn't find a reseller matching "${tokens.join(" ")}".\n\n` +
          `Resellers I do have:\n${list}`,
      };
    }

    // Pick the most common exact spelling as the display name.
    const nameQ = await client.query(
      `select o.reseller_name as name, count(*)::int as c
       from public.orders o where ${where}
       group by o.reseller_name order by c desc limit 1`
    );
    const displayName: string = nameQ.rows[0]?.name ?? tokens.join(" ");

    const statusQ = await client.query(
      `select coalesce(o.status,'(none)') as status,
              count(*)::int as orders, coalesce(sum(o.total),0) as amount
       from public.orders o where ${where}
       group by o.status order by orders desc`
    );

    const productsQ = await client.query(
      `select elem->>'name' as product,
              sum((elem->>'quantity')::numeric) as units,
              sum((elem->>'total')::numeric)    as revenue
       from public.orders o
       cross join lateral jsonb_array_elements(o.line_items) as elem
       where ${where}
       group by elem->>'name' order by units desc limit 10`
    );

    const ordersQ = await client.query(
      `select o.order_number, o.created_at, o.total, coalesce(o.status,'') as status,
              btrim(regexp_replace(coalesce(o.customer_name,''), '^\\s*Name\\s*:\\s*', '', 'i')) as customer
       from public.orders o where ${where}
       order by o.created_at desc limit 500`
    );

    // ----- chat summary -----
    const topLine = productsQ.rows[0]
      ? `Top product: ${productsQ.rows[0].product} (${Number(
          productsQ.rows[0].units
        )} units)`
      : "Top product: (none)";
    const summaryText =
      `${displayName} — complete details\n` +
      `Total orders: ${s.orders} | Total amount: ${inr(s.amount)}\n` +
      `Avg order: ${inr(s.avg_order)} | ` +
      `${ymd(s.first_order)} → ${ymd(s.last_order)}\n` +
      topLine +
      `\n(Full breakdown attached as CSV.)`;

    // ----- CSV -----
    const lines: string[] = [];
    lines.push(`${displayName} - Reseller Complete Details`);
    lines.push("");
    lines.push("Summary");
    lines.push(csvRow(["metric", "value"]));
    lines.push(csvRow(["Total orders", s.orders]));
    lines.push(csvRow(["Total amount", Number(s.amount).toFixed(2)]));
    lines.push(csvRow(["Average order", Number(s.avg_order).toFixed(2)]));
    lines.push(csvRow(["First order", ymd(s.first_order)]));
    lines.push(csvRow(["Last order", ymd(s.last_order)]));
    lines.push("");
    lines.push("Status breakdown");
    lines.push(csvRow(["status", "orders", "amount"]));
    for (const r of statusQ.rows)
      lines.push(csvRow([r.status, r.orders, Number(r.amount).toFixed(2)]));
    lines.push("");
    lines.push("Top products");
    lines.push(csvRow(["product", "units", "revenue"]));
    for (const r of productsQ.rows)
      lines.push(
        csvRow([r.product, Number(r.units), Number(r.revenue).toFixed(2)])
      );
    lines.push("");
    lines.push("Orders");
    lines.push(csvRow(["order_number", "date", "amount", "status", "customer"]));
    for (const r of ordersQ.rows)
      lines.push(
        csvRow([
          r.order_number,
          ymd(r.created_at),
          Number(r.total).toFixed(2),
          r.status,
          r.customer,
        ])
      );

    const slug =
      displayName.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") ||
      "reseller";
    return {
      found: true,
      displayName,
      summaryText,
      // BOM so Excel reads UTF-8 (₹, Tamil names) correctly.
      csv: "﻿" + lines.join("\r\n") + "\r\n",
      filename: `${slug}_complete_details.csv`,
    };
  });
}
