// Reseller order report: a chat summary plus a PDF and a CSV, always both,
// listing every order line with its product photo, customer, size/qty, price
// and status - with cancelled orders highlighted.
//
// This is a deterministic, code-driven report (not LLM SQL) so the numbers are
// always consistent. Orders come from public.orders UNION the archive in
// public.completed_orders, because orders are moved out of the live table once
// they finish and a report that reads only public.orders silently loses them.

import { withClientConnection } from "./clientDb.js";
import { config } from "../config.js";
import {
  parseDateRange,
  formatRangeSpan,
  PERIOD_WORDS,
  type DateRange,
} from "./dateRange.js";
import { PdfReport, type Column, type Row as PdfRow } from "./pdf.js";
import { loadThumbnails } from "./productImages.js";

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
 * Order lines pulled into the detail table. Deliberately far above
 * QUERY_ROW_LIMIT (which caps ad-hoc LLM queries): a month's orders are the
 * point of the report, and truncating them silently loses data the user asked
 * for. The totals are aggregated in SQL, so they stay correct either way.
 */
const LINE_ITEM_LIMIT = Math.max(config.queryRowLimit, 20000);

/**
 * Decide whether a message is a report request. Format words ("pdf", "csv") are
 * only a signal that a report is wanted - both files are always produced.
 */
export function parseReportRequest(text: string): ReportRequest {
  const tokens = extractResellerTokens(text);
  const phrase = REPORT_PHRASE_RE.test(text);
  const format = FORMAT_RE.test(text);
  const named = tokens.length > 0;

  return {
    // A bare "send it as pdf" with no name isn't a reseller report — let the
    // normal question flow handle it.
    isReport: phrase || (named && (format || ORDER_WORDS_RE.test(text))),
    explicit: phrase || (named && (format || /\breports?\b/i.test(text))),
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

/** One order line: an order joined to one of the products in it. */
interface LineRow {
  order_number: string;
  created_at: unknown;
  customer: string;
  phone: string;
  status: string;
  order_total: unknown;
  product: string;
  size: string;
  qty: number;
  price: number;
  line_total: number;
  image: string;
}

interface StatusRow {
  status: string;
  orders: number;
  amount: number;
}

/**
 * Orders as the report sees them: the live table plus the archive of finished
 * orders that have been moved out of it. Without the archive a report misses
 * every order that already completed. Deduplicated on order_number, live wins.
 */
const ORDER_SOURCE = `
  select o.order_number, o.customer_name, o.customer_phone, o.status, o.total,
         coalesce(o.line_items, '[]'::jsonb) as line_items,
         o.created_at, o.reseller_name
  from public.orders o
  union all
  select c.order_data->>'order_number', c.order_data->>'customer_name',
         c.order_data->>'customer_phone', c.order_data->>'status',
         nullif(c.order_data->>'total','')::numeric,
         coalesce(c.order_data->'line_items', '[]'::jsonb),
         coalesce(nullif(c.order_data->>'created_at','')::timestamptz, c.completed_at),
         c.order_data->>'reseller_name'
  from public.completed_orders c
  where not exists (
    select 1 from public.orders o2
    where o2.order_number = c.order_data->>'order_number'
  )`;

/** SQL and JS spelling of the same rule: which statuses mean "called off". */
const CANCELLED_SQL = `coalesce(s.status,'') ~* '(cancel|refund|return|fail|reject)'`;
export function isCancelled(status: string | null | undefined): boolean {
  return /cancel|refund|return|fail|reject/i.test(status ?? "");
}

/** Status as shown in reports: flagged unless the word already says so. */
function statusLabel(status: string): string {
  if (!isCancelled(status) || /cancel/i.test(status)) return status;
  return `${status} (CANCELLED)`;
}

/**
 * Build a report for the reseller named in `question`, over the period it
 * mentions ("last month", "june 2025", ... ; all time when it mentions none).
 * Always produces both a PDF and a CSV. Returns found:false with the candidate
 * names when the reseller can't be identified.
 */
export async function buildResellerReport(
  connectionString: string,
  question: string,
  request: ReportRequest = parseReportRequest(question),
  /** Skip name matching and report on exactly this reseller (a button tap). */
  chosenKey?: string
): Promise<ResellerReport> {
  const { tokens, range } = request;
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
      `with src as (${ORDER_SOURCE})
       select s.reseller_name as name, count(*)::int as orders
       from src s
       where s.reseller_name is not null and btrim(s.reseller_name) <> ''
       group by s.reseller_name order by orders desc`
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
    const nameWhere = `regexp_replace(lower(s.reseller_name), '[^a-z0-9]+', '', 'g') = '${resolved.match.key}'`;
    const periodWhere = range ? ` and s.created_at >= $1 and s.created_at < $2` : "";
    const params: unknown[] = range ? [range.start, range.end] : [];
    const where = nameWhere + periodWhere;

    const summaryQ = await client.query(
      `with src as (${ORDER_SOURCE})
       select count(*)::int                                          as orders,
              coalesce(sum(s.total),0)                                as amount,
              count(*) filter (where ${CANCELLED_SQL})::int           as cancelled_orders,
              coalesce(sum(s.total) filter (where ${CANCELLED_SQL}),0) as cancelled_amount,
              min(s.created_at)                                       as first_order,
              max(s.created_at)                                       as last_order
       from src s where ${where}`,
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
      `with src as (${ORDER_SOURCE})
       select coalesce(nullif(btrim(s.status),''),'(none)') as status,
              count(*)::int as orders, coalesce(sum(s.total),0) as amount
       from src s where ${where}
       group by 1 order by orders desc`,
      params
    );
    const statusRows: StatusRow[] = statusQ.rows.map((r) => ({
      status: String(r.status),
      orders: Number(r.orders),
      amount: Number(r.amount),
    }));

    // One row per product per order. LEFT JOIN so an order with no line items
    // still appears - it is still one of the reseller's orders.
    const linesQ = await client.query(
      `with src as (${ORDER_SOURCE})
       select s.order_number,
              s.created_at,
              btrim(regexp_replace(coalesce(s.customer_name,''), '^\\s*Name\\s*:\\s*', '', 'i')) as customer,
              coalesce(s.customer_phone,'')                as phone,
              coalesce(nullif(btrim(s.status),''),'')      as status,
              s.total                                      as order_total,
              coalesce(elem->>'name','')                   as product,
              coalesce(elem->>'size','')                   as size,
              coalesce((elem->>'quantity')::numeric,0)     as qty,
              coalesce((elem->>'price')::numeric,0)        as price,
              coalesce((elem->>'total')::numeric,0)        as line_total,
              coalesce(elem->>'image','')                  as image
       from src s
       left join lateral jsonb_array_elements(s.line_items)
            with ordinality as t(elem, ord) on true
       where ${where}
       order by s.created_at desc, s.order_number desc, t.ord
       limit ${LINE_ITEM_LIMIT}`,
      params
    );
    const lines = linesQ.rows as LineRow[];

    const distinctOrders = new Set(lines.map((l) => l.order_number)).size;
    const truncated = distinctOrders < Number(s.orders);

    // Product photos: one fetch per distinct URL, cached across reports.
    let thumbs = new Map<string, Buffer>();
    try {
      thumbs = await loadThumbnails(lines.map((l) => l.image).filter(Boolean));
    } catch (e) {
      console.error("[report] thumbnails failed:", e);
    }

    const data: ReportData = {
      displayName,
      periodLabel,
      spanText: range
        ? formatRangeSpan(range)
        : `${ymd(s.first_order)} to ${ymd(s.last_order)}`,
      totalOrders: Number(s.orders),
      totalValue: Number(s.amount),
      cancelledOrders: Number(s.cancelled_orders),
      cancelledValue: Number(s.cancelled_amount),
      statusRows,
      lines,
      truncated,
      thumbs,
    };

    const summaryText =
      `${displayName} — ${periodLabel}\n` +
      `Date range: ${data.spanText}\n` +
      `Total orders: ${num(data.totalOrders)}\n` +
      `Total order value: ${inr(data.totalValue)}\n` +
      (data.cancelledOrders > 0
        ? `Cancelled: ${num(data.cancelledOrders)} order(s), ${inr(data.cancelledValue)}`
        : `Cancelled: none`) +
      `\n(PDF and CSV attached.)`;

    const base = `${slugify(displayName) || "reseller"}_${
      slugify(periodLabel) || "all_time"
    }_report`;

    return {
      found: true,
      displayName,
      summaryText,
      files: [
        { filename: `${base}.pdf`, data: await buildPdf(data) },
        // BOM so Excel reads UTF-8 (₹, Tamil names) correctly.
        { filename: `${base}.csv`, data: Buffer.from("﻿" + buildCsv(data), "utf8") },
      ],
    };
  });
}

/** Everything the PDF and CSV renderers need. */
export interface ReportData {
  displayName: string;
  periodLabel: string;
  spanText: string;
  totalOrders: number;
  totalValue: number;
  cancelledOrders: number;
  cancelledValue: number;
  statusRows: StatusRow[];
  lines: LineRow[];
  truncated: boolean;
  thumbs?: Map<string, Buffer>;
}

/** "M · Qty 2", or just "Qty 2" when the product has no size. */
function sizeQty(l: LineRow): string {
  const size = (l.size ?? "").trim();
  const qty = Number(l.qty || 0);
  if (!l.product) return "";
  return size ? `${size.toUpperCase()} · Qty ${num(qty)}` : `Qty ${num(qty)}`;
}

/** The detail table, shared by the full listing and the cancelled-only one. */
function detailColumns(): Column[] {
  return [
    { header: "S.No", width: 0.6, align: "right" },
    { header: "Order ID", width: 1.3 },
    { header: "Photo", width: 0.95, image: true },
    { header: "Product", width: 3.1 },
    { header: "Customer", width: 2.1 },
    { header: "Phone", width: 1.5 },
    { header: "Size / Qty", width: 1.15 },
    { header: "Price", width: 1.1, align: "right" },
    { header: "Status", width: 1.3 },
  ];
}

function detailRows(lines: LineRow[], thumbs?: Map<string, Buffer>): PdfRow[] {
  return lines.map((l, i) => ({
    cells: [
      i + 1,
      l.order_number,
      (l.image && thumbs?.get(l.image)) || "",
      l.product || "(no line items)",
      l.customer,
      l.phone,
      sizeQty(l),
      l.product ? inr(l.price) : inr(l.order_total),
      statusLabel(l.status),
    ],
    highlight: isCancelled(l.status),
  }));
}

export async function buildPdf(d: ReportData): Promise<Buffer> {
  // Landscape: the detail table carries nine columns plus a photo.
  const pdf = new PdfReport({ landscape: true });

  pdf.title(
    d.displayName,
    `Order report — ${d.periodLabel}`,
    `${d.spanText}  ·  generated ${new Date()
      .toISOString()
      .slice(0, 16)
      .replace("T", " ")} UTC`
  );

  // The date range is in the title and the summary block; a KPI box is too
  // narrow for it.
  pdf.kpis([
    { label: "Total orders", value: num(d.totalOrders) },
    { label: "Total order value", value: inr(d.totalValue) },
    { label: "Cancelled orders", value: num(d.cancelledOrders) },
  ]);

  pdf.totalBar("Total order value", inr(d.totalValue));

  pdf.section("Summary");
  pdf.keyValues([
    ["Date range", `${d.periodLabel} (${d.spanText})`],
    ["Total orders", num(d.totalOrders)],
    ["Total order value", inr(d.totalValue)],
  ]);

  pdf.section("Orders by status");
  pdf.table(
    [
      { header: "Status", width: 4 },
      { header: "Orders", width: 2, align: "right" },
      { header: "Value", width: 3, align: "right" },
    ],
    [
      ...d.statusRows.map((r) => ({
        cells: [
          statusLabel(r.status),
          num(r.orders),
          inr(r.amount),
        ],
        highlight: isCancelled(r.status),
      })),
      { cells: ["TOTAL", num(d.totalOrders), inr(d.totalValue)] },
    ]
  );
  pdf.note(
    d.cancelledOrders > 0
      ? `Cancelled orders: ${num(d.cancelledOrders)} (${inr(
          d.cancelledValue
        )}) — highlighted in red throughout this report.`
      : `Cancelled orders: 0 — no cancelled orders in this period.`
  );

  pdf.section("Order details");
  if (d.truncated) {
    pdf.note(
      `Showing the most recent ${
        new Set(d.lines.map((l) => l.order_number)).size
      } of ${num(d.totalOrders)} orders.`
    );
  }
  pdf.table(detailColumns(), detailRows(d.lines, d.thumbs));

  const cancelledLines = d.lines.filter((l) => isCancelled(l.status));
  if (cancelledLines.length > 0) {
    pdf.section("Cancelled orders");
    pdf.table(detailColumns(), detailRows(cancelledLines, d.thumbs));
  }

  return pdf.finish(`${d.displayName} · ${d.periodLabel}`);
}

export function buildCsv(d: ReportData): string {
  const lines: string[] = [];
  lines.push(`${d.displayName} - Order report - ${d.periodLabel}`);
  lines.push("");
  lines.push("Summary");
  lines.push(csvRow(["metric", "value"]));
  lines.push(csvRow(["Date range", d.spanText]));
  lines.push(csvRow(["Total orders", d.totalOrders]));
  lines.push(csvRow(["Total order value", money(d.totalValue)]));
  lines.push(csvRow(["Cancelled orders", d.cancelledOrders]));
  lines.push(csvRow(["Cancelled order value", money(d.cancelledValue)]));
  lines.push("");
  lines.push("Orders by status");
  lines.push(csvRow(["status", "cancelled", "orders", "value"]));
  for (const r of d.statusRows) {
    lines.push(
      csvRow([r.status, isCancelled(r.status) ? "YES" : "", r.orders, money(r.amount)])
    );
  }
  lines.push(csvRow(["TOTAL", "", d.totalOrders, money(d.totalValue)]));
  lines.push("");
  lines.push("Order details");
  lines.push(
    csvRow([
      "s_no", "order_id", "order_date", "product", "size", "quantity",
      "product_price", "line_total", "customer_name", "customer_phone",
      "order_status", "cancelled", "order_total", "product_image",
    ])
  );
  d.lines.forEach((l, i) => {
    lines.push(
      csvRow([
        i + 1,
        l.order_number,
        ymd(l.created_at),
        l.product,
        l.size,
        Number(l.qty || 0),
        money(l.price),
        money(l.line_total),
        l.customer,
        l.phone,
        l.status,
        isCancelled(l.status) ? "YES" : "",
        money(l.order_total),
        l.image,
      ])
    );
  });
  return lines.join("\r\n") + "\r\n";
}
