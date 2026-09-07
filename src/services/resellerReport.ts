// Reseller order report: a chat summary plus downloadable PDF and/or CSV files
// covering the orders, the products in them, and the overall total value.
//
// This is a deterministic, code-driven report (not LLM SQL) so the numbers are
// always consistent. Reseller data lives in public.orders.reseller_name /
// public.orders.total; the resellers table is config-only and often empty.
//
// "dreamcouture last month orders"  -> PDF (default)
// "dreamcouture last month orders in pdf and csv" -> both files

import { withClientConnection } from "./clientDb.js";
import { config } from "../config.js";
import {
  parseDateRange,
  formatRangeSpan,
  PERIOD_WORDS,
  type DateRange,
} from "./dateRange.js";
import { PdfReport, type Column } from "./pdf.js";

export interface ReportFile {
  filename: string;
  data: Buffer;
}

export interface ResellerReport {
  found: boolean;
  displayName?: string;
  /** Short summary to show in the chat. */
  summaryText: string;
  /** Generated attachments, in the order they should be sent. */
  files: ReportFile[];
  /**
   * Reseller names to offer as a choice when the name didn't match or matched
   * two resellers equally well.
   */
  candidates?: Candidate[];
}

/** What a message is asking for, once parsed. */
export interface ReportRequest {
  /** Handle this message as a reseller report rather than an ad-hoc question. */
  isReport: boolean;
  /**
   * The user clearly asked for a report/file. Implicit requests (a name plus
   * "orders") fall back to the normal question flow when no reseller matches.
   */
  explicit: boolean;
  formats: { pdf: boolean; csv: boolean };
  range: DateRange | null;
  /** Distinctive words to match a reseller name by. */
  tokens: string[];
}

// Words that are never part of a reseller's name in a report request: request
// verbs, question words, metric words, and generic shop/brand words (so the same
// reseller stored under several spellings — 'Shiny boutique' vs 'Shiny' — is
// still matched by its distinctive token).
const FILLERS = new Set([
  "complete", "full", "all", "details", "detail", "report", "reports",
  "reseller", "resellers", "reselling", "give", "get", "show", "send", "share",
  "need", "want", "me", "my", "our", "the", "of", "for", "with", "and", "also",
  "please", "kindly", "total", "totals", "orders", "order", "ordered",
  "amount", "amounts", "top", "product", "products", "csv", "pdf", "excel",
  "spreadsheet", "file", "format", "both", "his", "her", "their", "info",
  "information", "summary", "data", "sales", "sale", "value", "values",
  "revenue", "price", "prices", "quantity", "qty", "units", "item", "items",
  "customer", "customers", "status", "how", "many", "much", "what", "which",
  "when", "who", "why", "list", "count", "number", "numbers", "average",
  "avg", "each", "any", "are", "was", "were", "did", "does", "has", "have",
  "had", "been", "per", "between", "over", "under", "about", "into", "sold",
  "sell", "sells", "bought", "buy", "most", "least", "best", "worst", "more",
  "less", "than", "then", "highest", "lowest", "new", "old", "made", "make",
  "purchase", "purchases", "invoice", "invoices", "transaction", "transactions",
  "billing", "billed", "breakdown", "detailed", "entire", "overall",
  // Store-routing words (handled by dbRouter), never reseller names.
  "blacklovers", "black", "lovers",
  "boutique", "collection", "couture", "lifestyle", "store", "shop", "fashion",
  "fashions", "textiles", "creations", "designs", "studio", "brand", "seller",
]);

const FORMAT_RE = /\b(pdf|csv|excel|spreadsheet)\b/i;
const REPORT_PHRASE_RE =
  /\b(complete|full|all|detailed|entire)\b[\s\w]*\b(details?|report|info(?:rmation)?|breakdown)\b/i;
const ORDER_WORDS_RE =
  /\b(orders?|sales?|purchases?|invoices?|details?|report|billing|transactions?)\b/i;

/**
 * Rows pulled into the order list / line-item sections. Deliberately far above
 * QUERY_ROW_LIMIT (which caps ad-hoc LLM queries): a month's orders are the
 * point of the report, and truncating them silently loses data the user asked
 * for. The totals are aggregated in SQL, so they stay correct either way.
 */
const ORDER_LIMIT = Math.max(config.queryRowLimit, 5000);
const LINE_ITEM_LIMIT = 20000;

/** Decide whether a message is a report request, and in which formats. */
export function parseReportRequest(text: string): ReportRequest {
  const tokens = extractResellerTokens(text);
  const phrase = REPORT_PHRASE_RE.test(text);
  const format = FORMAT_RE.test(text);
  const named = tokens.length > 0;

  const wantsCsv = /\b(csv|excel|spreadsheet)\b/i.test(text);
  const wantsPdf = /\bpdf\b/i.test(text);
  const wantsBoth = /\bboth\b/i.test(text) || (wantsCsv && wantsPdf);

  return {
    // A bare "send it as pdf" with no name isn't a reseller report — let the
    // normal question flow handle it.
    isReport: phrase || (named && (format || ORDER_WORDS_RE.test(text))),
    explicit: phrase || (named && (format || /\breports?\b/i.test(text))),
    formats: wantsBoth
      ? { pdf: true, csv: true }
      : { pdf: !wantsCsv, csv: wantsCsv },
    range: parseDateRange(text),
    tokens,
  };
}

/** Kept for backwards compatibility with earlier call sites. */
export function isCompleteDetailsRequest(text: string): boolean {
  return parseReportRequest(text).isReport;
}

/** Distinctive name tokens (alphanumeric, non-filler) to match a reseller by. */
export function extractResellerTokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(
      (w) =>
        w.length >= 3 &&
        !FILLERS.has(w) &&
        !PERIOD_WORDS.has(w) &&
        !/^\d+$/.test(w)
    );
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
function num(v: unknown): string {
  const n = Number(v ?? 0);
  return n.toLocaleString("en-IN", { maximumFractionDigits: 2 });
}
function money(v: unknown): string {
  return Number(v ?? 0).toFixed(2);
}
function ymd(v: unknown): string {
  if (!v) return "";
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? String(v) : d.toISOString().slice(0, 10);
}
function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}

/**
 * Comparison key for a reseller name: lowercase, letters and digits only.
 * "Dreams couture", "Dreams Couture" and "dreams-couture" all collapse to
 * "dreamscouture", so spellings of one reseller are counted together.
 */
export function normalizeName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/** Dice coefficient over character bigrams: 1 = identical, 0 = nothing shared. */
function dice(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const bigrams = new Map<string, number>();
  for (let i = 0; i < a.length - 1; i++) {
    const g = a.slice(i, i + 2);
    bigrams.set(g, (bigrams.get(g) ?? 0) + 1);
  }
  let hits = 0;
  for (let i = 0; i < b.length - 1; i++) {
    const g = b.slice(i, i + 2);
    const n = bigrams.get(g) ?? 0;
    if (n > 0) {
      bigrams.set(g, n - 1);
      hits++;
    }
  }
  return (2 * hits) / (a.length - 1 + (b.length - 1));
}

/**
 * How well a reseller name answers the words the user typed. Typing runs
 * spellings together ("dreamcouture" for "Dreams couture") and drops generic
 * words ("shiny" for "Shiny boutique"), so exact containment is not enough.
 */
export function scoreName(tokens: string[], candidate: string): number {
  const c = normalizeName(candidate);
  const q = normalizeName(tokens.join(""));
  if (!c || !q) return 0;
  if (c === q) return 1;
  // One contains the other: "shiny" -> "shinyboutique".
  if (c.includes(q) || q.includes(c)) return 0.95;
  // Every typed word appears somewhere in the name, in any order.
  const allPresent =
    tokens.length > 0 && tokens.every((t) => c.includes(normalizeName(t)));
  if (allPresent) return 0.9;
  // Otherwise fall back to spelling similarity: "dreamcouture" vs
  // "dreamscouture" differ by one letter and still have to match.
  return dice(q, c);
}

/** A reseller name as stored, with how many orders it has. */
export interface Candidate {
  /** Most common original spelling. */
  name: string;
  /** Comparison key shared by all spellings of this reseller. */
  key: string;
  orders: number;
}

/** Minimum score to accept a match without asking the user. */
const MATCH_THRESHOLD = 0.62;

/**
 * Pick the reseller the user meant. Returns the best match plus the full
 * candidate list, so the caller can offer a choice when nothing scores well or
 * two names score alike.
 */
export function resolveReseller(
  tokens: string[],
  candidates: Candidate[]
): { match?: Candidate; ambiguous: boolean; ranked: Candidate[] } {
  const scored = candidates
    .map((c) => ({ c, score: scoreName(tokens, c.name) }))
    .sort((a, b) => b.score - a.score || b.c.orders - a.c.orders);

  const best = scored[0];
  const runnerUp = scored[1];
  if (!best || best.score < MATCH_THRESHOLD) {
    return { ambiguous: false, ranked: candidates };
  }
  // Two names that fit about equally well - let the user pick.
  if (runnerUp && runnerUp.score >= MATCH_THRESHOLD && best.score - runnerUp.score < 0.1) {
    return { ambiguous: true, ranked: scored.map((s) => s.c) };
  }
  return { match: best.c, ambiguous: false, ranked: scored.map((s) => s.c) };
}

interface OrderRow {
  order_number: string;
  created_at: unknown;
  total: unknown;
  status: string;
  customer: string;
  items: number;
}
interface ItemRow {
  order_number: string;
  product: string;
  qty: number;
  price: number;
  line_total: number;
}

/**
 * Build a report for the reseller named in `question`, over the period it
 * mentions ("last month", "june 2025", ... ; all time when it mentions none).
 * Matches reseller_name by ANDing the distinctive tokens (injection-safe: tokens
 * are [a-z0-9]+). Returns found:false with a helpful summary if no match.
 */
export async function buildResellerReport(
  connectionString: string,
  question: string,
  request: ReportRequest = parseReportRequest(question),
  /** Skip name matching and report on exactly this reseller (a button tap). */
  chosenKey?: string
): Promise<ResellerReport> {
  const { tokens, range, formats } = request;
  if (tokens.length === 0 && !chosenKey) {
    return {
      found: false,
      summaryText: 'Which reseller? Try e.g. "dreamcouture last month orders".',
      files: [],
    };
  }

  const periodLabel = range ? range.label : "All time";

  return withClientConnection(connectionString, async (client) => {
    // Every reseller name in the data, spellings of one name folded together
    // ("Cod Corner" + "Cod corner"). Matching happens here rather than in SQL
    // because people run names together and drop words: "dreamcouture" has to
    // find "Dreams couture", which no LIKE pattern does.
    const namesQ = await client.query(
      `select o.reseller_name as name, count(*)::int as orders
       from public.orders o
       where o.reseller_name is not null and btrim(o.reseller_name) <> ''
       group by o.reseller_name order by orders desc`
    );
    const byKey = new Map<string, Candidate>();
    for (const r of namesQ.rows) {
      const key = normalizeName(String(r.name));
      if (!key) continue;
      const existing = byKey.get(key);
      // Keep the spelling used by the most orders as the display name.
      if (existing) existing.orders += Number(r.orders);
      else byKey.set(key, { name: String(r.name), key, orders: Number(r.orders) });
    }
    const candidates = [...byKey.values()].sort((a, b) => b.orders - a.orders);

    const resolved = chosenKey
      ? { match: byKey.get(chosenKey), ambiguous: false, ranked: candidates }
      : resolveReseller(tokens, candidates);

    if (!resolved.match) {
      const list = resolved.ranked
        .slice(0, 15)
        .map((c) => `- ${c.name} (${c.orders})`)
        .join("\n");
      return {
        found: false,
        summaryText: resolved.ambiguous
          ? `More than one reseller matches "${tokens.join(" ")}". Which one?`
          : `I couldn't find a reseller matching "${tokens.join(" ")}".\n\n` +
            `Resellers I do have:\n${list}`,
        files: [],
        candidates: resolved.ranked.slice(0, 15),
      };
    }

    const displayName = resolved.match.name;
    // The key is [a-z0-9] only, so this literal is injection-safe.
    const nameWhere = `regexp_replace(lower(o.reseller_name), '[^a-z0-9]+', '', 'g') = '${resolved.match.key}'`;
    const periodWhere = range ? ` and o.created_at >= $1 and o.created_at < $2` : "";
    const params: unknown[] = range ? [range.start, range.end] : [];
    const where = nameWhere + periodWhere;

    const summaryQ = await client.query(
      `select count(*)::int                       as orders,
              coalesce(sum(o.total),0)            as amount,
              coalesce(avg(o.total),0)            as avg_order,
              count(distinct o.customer_name)::int as customers,
              min(o.created_at)                   as first_order,
              max(o.created_at)                   as last_order
       from public.orders o
       where ${where}`,
      params
    );
    const s = summaryQ.rows[0];

    // Known reseller, but nothing in the requested window.
    if (!s || Number(s.orders) === 0) {
      return {
        found: true,
        displayName,
        summaryText:
          `${displayName} — no orders in ${periodLabel}` +
          (range ? ` (${formatRangeSpan(range)}).` : ".") +
          `\nTry a different period, e.g. "${displayName} all orders".`,
        files: [],
      };
    }

    const statusQ = await client.query(
      `select coalesce(o.status,'(none)') as status,
              count(*)::int as orders, coalesce(sum(o.total),0) as amount
       from public.orders o where ${where}
       group by o.status order by orders desc`,
      params
    );

    const productsQ = await client.query(
      `select elem->>'name' as product,
              sum(coalesce((elem->>'quantity')::numeric,0)) as units,
              sum(coalesce((elem->>'total')::numeric,0))    as revenue,
              count(distinct o.order_number)::int            as orders
       from public.orders o
       cross join lateral jsonb_array_elements(coalesce(o.line_items,'[]'::jsonb)) as elem
       where ${where}
       group by elem->>'name' order by revenue desc`,
      params
    );

    const ordersQ = await client.query(
      `select o.order_number, o.created_at, o.total, coalesce(o.status,'') as status,
              btrim(regexp_replace(coalesce(o.customer_name,''), '^\\s*Name\\s*:\\s*', '', 'i')) as customer,
              coalesce(jsonb_array_length(coalesce(o.line_items,'[]'::jsonb)),0)::int as items
       from public.orders o where ${where}
       order by o.created_at desc limit ${ORDER_LIMIT}`,
      params
    );
    const orders = ordersQ.rows as OrderRow[];

    const itemsQ = await client.query(
      `select o.order_number,
              elem->>'name'                                as product,
              coalesce((elem->>'quantity')::numeric,0)     as qty,
              coalesce((elem->>'price')::numeric,0)        as price,
              coalesce((elem->>'total')::numeric,0)        as line_total
       from (
         select * from public.orders o where ${where}
         order by o.created_at desc limit ${ORDER_LIMIT}
       ) o
       cross join lateral jsonb_array_elements(coalesce(o.line_items,'[]'::jsonb)) as elem
       order by o.created_at desc limit ${LINE_ITEM_LIMIT}`,
      params
    );
    const items = itemsQ.rows as ItemRow[];

    const itemsByOrder = new Map<string, ItemRow[]>();
    for (const it of items) {
      const list = itemsByOrder.get(it.order_number);
      if (list) list.push(it);
      else itemsByOrder.set(it.order_number, [it]);
    }

    const totalUnits = productsQ.rows.reduce((a, r) => a + Number(r.units || 0), 0);
    const spanText = range ? formatRangeSpan(range) : `${ymd(s.first_order)} to ${ymd(s.last_order)}`;
    const truncated = Number(s.orders) > orders.length;

    // ----- chat summary -----
    const top = productsQ.rows[0];
    const summaryText =
      `${displayName} — ${periodLabel}\n` +
      `Total orders: ${s.orders}\n` +
      `Overall total value: ${inr(s.amount)}\n` +
      `Average order: ${inr(s.avg_order)} | Units sold: ${num(totalUnits)}\n` +
      `Period: ${spanText}\n` +
      (top
        ? `Top product: ${top.product} (${num(top.units)} units, ${inr(top.revenue)})`
        : "Top product: (none)");

    // ----- files -----
    const base = `${slugify(displayName) || "reseller"}_${slugify(periodLabel) || "all_time"}_report`;
    const files: ReportFile[] = [];

    if (formats.pdf) {
      const pdf = await buildPdf({
        displayName,
        periodLabel,
        spanText,
        summary: s,
        totalUnits,
        statusRows: statusQ.rows,
        productRows: productsQ.rows,
        orders,
        itemsByOrder,
        truncated,
      });
      files.push({ filename: `${base}.pdf`, data: pdf });
    }

    if (formats.csv) {
      const csv = buildCsv({
        displayName,
        periodLabel,
        spanText,
        summary: s,
        totalUnits,
        statusRows: statusQ.rows,
        productRows: productsQ.rows,
        orders,
        items,
      });
      // BOM so Excel reads UTF-8 (₹, Tamil names) correctly.
      files.push({
        filename: `${base}.csv`,
        data: Buffer.from("﻿" + csv, "utf8"),
      });
    }

    return { found: true, displayName, summaryText, files };
  });
}

/** Shape handed to the file renderers (exported so they can be tested standalone). */
export interface ReportData {
  displayName: string;
  periodLabel: string;
  spanText: string;
  summary: Record<string, unknown>;
  totalUnits: number;
  statusRows: Record<string, unknown>[];
  productRows: Record<string, unknown>[];
  orders: OrderRow[];
  itemsByOrder?: Map<string, ItemRow[]>;
  items?: ItemRow[];
  truncated?: boolean;
}

export async function buildPdf(d: ReportData): Promise<Buffer> {
  const s = d.summary;
  const pdf = new PdfReport();

  pdf.title(
    d.displayName,
    `Order report — ${d.periodLabel}`,
    `${d.spanText}  ·  generated ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC`
  );

  pdf.kpis([
    { label: "Orders", value: String(s.orders) },
    { label: "Total value", value: inr(s.amount) },
    { label: "Avg order", value: inr(s.avg_order) },
    { label: "Units", value: num(d.totalUnits) },
  ]);

  pdf.totalBar("Overall total value", inr(s.amount));

  pdf.section("Summary");
  pdf.keyValues([
    ["Period", `${d.periodLabel} (${d.spanText})`],
    ["Total orders", String(s.orders)],
    ["Overall total value", inr(s.amount)],
    ["Average order value", inr(s.avg_order)],
    ["Total units sold", num(d.totalUnits)],
    ["Distinct products", String(d.productRows.length)],
    ["First order", ymd(s.first_order)],
    ["Last order", ymd(s.last_order)],
  ]);

  if (d.statusRows.length > 0) {
    pdf.section("Orders by status");
    const cols: Column[] = [
      { header: "Status", width: 4 },
      { header: "Orders", width: 2, align: "right" },
      { header: "Amount", width: 3, align: "right" },
    ];
    pdf.table(
      cols,
      d.statusRows.map((r) => [String(r.status), String(r.orders), inr(r.amount)])
    );
  }

  pdf.section("Product details");
  if (d.productRows.length === 0) {
    pdf.note("No line items recorded for these orders.");
  } else {
    const cols: Column[] = [
      { header: "#", width: 0.8, align: "right" },
      { header: "Product", width: 7 },
      { header: "Orders", width: 1.5, align: "right" },
      { header: "Units", width: 1.5, align: "right" },
      { header: "Revenue", width: 2.4, align: "right" },
    ];
    const productRevenue = d.productRows.reduce((a, r) => a + Number(r.revenue || 0), 0);
    pdf.table(
      cols,
      [
        ...d.productRows.map((r, i) => [
          i + 1,
          String(r.product ?? "(unnamed)"),
          String(r.orders ?? ""),
          num(r.units),
          inr(r.revenue),
        ]),
        ["", "TOTAL", "", num(d.totalUnits), inr(productRevenue)],
      ]
    );
    // Line-item revenue can differ from order totals (shipping, discounts), so
    // both figures are shown rather than silently reconciled.
    if (Math.round(productRevenue) !== Math.round(Number(s.amount))) {
      pdf.note(
        `Line-item revenue ${inr(productRevenue)} differs from the order total ` +
          `${inr(s.amount)} (shipping, discounts or charges recorded at order level).`
      );
    }
  }

  pdf.section("Orders");
  if (d.truncated) {
    pdf.note(`Showing the ${d.orders.length} most recent of ${s.orders} orders.`);
  }
  const orderCols: Column[] = [
    { header: "Order #", width: 2.4 },
    { header: "Date", width: 1.8 },
    { header: "Customer", width: 3.6 },
    { header: "Status", width: 1.8 },
    { header: "Items", width: 1, align: "right" },
    { header: "Amount", width: 2, align: "right" },
  ];
  const orderRows: (string | number)[][] = d.orders.map((o) => [
    o.order_number,
    ymd(o.created_at),
    o.customer,
    o.status,
    o.items,
    inr(o.total),
  ]);
  if (!d.truncated) {
    orderRows.push(["TOTAL", "", "", "", String(s.orders), inr(s.amount)]);
  }
  pdf.table(orderCols, orderRows);

  // Per-order products: what was actually bought in each order.
  const byOrder = d.itemsByOrder;
  if (byOrder && byOrder.size > 0) {
    pdf.section("Products in each order");
    const itemCols: Column[] = [
      { header: "Order #", width: 2.4 },
      { header: "Date", width: 1.8 },
      { header: "Product", width: 5.4 },
      { header: "Qty", width: 1, align: "right" },
      { header: "Unit price", width: 1.7, align: "right" },
      { header: "Line total", width: 1.9, align: "right" },
    ];
    const rows: (string | number)[][] = [];
    for (const o of d.orders) {
      const list = byOrder.get(o.order_number);
      if (!list) continue;
      list.forEach((it, i) => {
        const qty = Number(it.qty || 0);
        const unit = Number(it.price) || (qty > 0 ? Number(it.line_total) / qty : 0);
        rows.push([
          i === 0 ? o.order_number : "",
          i === 0 ? ymd(o.created_at) : "",
          it.product ?? "(unnamed)",
          num(qty),
          inr(unit),
          inr(it.line_total),
        ]);
      });
    }
    pdf.table(itemCols, rows);
  }

  return pdf.finish(`${d.displayName} · ${d.periodLabel}`);
}

export function buildCsv(d: ReportData): string {
  const s = d.summary;
  const lines: string[] = [];
  lines.push(`${d.displayName} - Order report - ${d.periodLabel}`);
  lines.push(`Period,${csvCell(d.spanText)}`);
  lines.push("");
  lines.push("Summary");
  lines.push(csvRow(["metric", "value"]));
  lines.push(csvRow(["Total orders", s.orders]));
  lines.push(csvRow(["Overall total value", money(s.amount)]));
  lines.push(csvRow(["Average order value", money(s.avg_order)]));
  lines.push(csvRow(["Total units sold", d.totalUnits]));
  lines.push(csvRow(["Distinct products", d.productRows.length]));
  lines.push(csvRow(["First order", ymd(s.first_order)]));
  lines.push(csvRow(["Last order", ymd(s.last_order)]));
  lines.push("");
  lines.push("Orders by status");
  lines.push(csvRow(["status", "orders", "amount"]));
  for (const r of d.statusRows)
    lines.push(csvRow([r.status, r.orders, money(r.amount)]));
  lines.push("");
  lines.push("Product details");
  lines.push(csvRow(["product", "orders", "units", "revenue"]));
  for (const r of d.productRows)
    lines.push(csvRow([r.product, r.orders, Number(r.units), money(r.revenue)]));
  lines.push(
    csvRow([
      "TOTAL",
      "",
      d.totalUnits,
      money(d.productRows.reduce((a, r) => a + Number(r.revenue || 0), 0)),
    ])
  );
  lines.push("");
  lines.push("Orders");
  lines.push(csvRow(["order_number", "date", "customer", "status", "items", "amount"]));
  for (const o of d.orders)
    lines.push(
      csvRow([o.order_number, ymd(o.created_at), o.customer, o.status, o.items, money(o.total)])
    );
  lines.push(csvRow(["TOTAL", "", "", "", "", money(s.amount)]));

  if (d.items && d.items.length > 0) {
    lines.push("");
    lines.push("Products in each order");
    lines.push(csvRow(["order_number", "product", "quantity", "unit_price", "line_total"]));
    for (const it of d.items) {
      const qty = Number(it.qty || 0);
      const unit = Number(it.price) || (qty > 0 ? Number(it.line_total) / qty : 0);
      lines.push(
        csvRow([it.order_number, it.product, qty, money(unit), money(it.line_total)])
      );
    }
  }

  return lines.join("\r\n") + "\r\n";
}
