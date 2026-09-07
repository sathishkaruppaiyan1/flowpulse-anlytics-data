// "How many cancelled orders are there?" cannot be answered with SQL.
//
// The database never learns that an order was called off (see wooStatus.ts), so
// generated SQL over public.orders answers 0 every time, confidently and
// wrongly. Reports already overlay WooCommerce's own list; this does the same
// for a question asked in passing, so both routes give the same number.
//
// Only cancellation questions are intercepted. Everything else goes to the
// normal question pipeline untouched, and so does a cancellation question this
// can't answer - an unreachable store falls back rather than inventing a total.

import { withClientConnection } from "./clientDb.js";
import { parseDateRange, formatRangeSpan } from "./dateRange.js";
import { loadCalledOffOrders, type WooCalledOffOrder } from "./wooStatus.js";
import {
  groupResellers,
  normalizeName,
  normalizeNumber,
  type Candidate,
} from "./resellerReport.js";

/** Words that make a question one about called-off orders. */
const CANCELLED_RE = /\b(cancel(?:led|ed|lation|lations)?|refund(?:ed|s)?|returned|failed)\b/i;
/** ... but not one about how to cancel something. */
const HOW_TO_RE = /\b(how (?:do|can|to)|cancel it|policy|procedure)\b/i;

export function isCancellationQuestion(text: string): boolean {
  return CANCELLED_RE.test(text) && !HOW_TO_RE.test(text);
}

/**
 * A deterministic answer to a cancellation question, or null to let the normal
 * pipeline handle it.
 */
export async function answerCancelledQuestion(
  connectionString: string,
  question: string
): Promise<string | null> {
  if (!isCancellationQuestion(question)) return null;

  return withClientConnection(connectionString, async (client) => {
    const calledOff = await loadCalledOffOrders(client);
    // No store configured, or it couldn't be reached: say nothing rather than
    // report a total we can't stand behind.
    if (calledOff.length === 0) return null;

    const range = parseDateRange(question);
    const inPeriod = range
      ? calledOff.filter((o) => {
          const at = new Date(o.created_at);
          return at >= range.start && at < range.end;
        })
      : calledOff;

    const periodLabel = range
      ? `${range.label} (${formatRangeSpan(range)})`
      : "all time";

    if (inPeriod.length === 0) {
      return `No cancelled orders in ${periodLabel}.`;
    }

    const total = inPeriod.reduce((sum, o) => sum + o.total, 0);
    const byStatus = countBy(inPeriod, (o) => o.status || "cancelled");
    const byReseller = await splitByReseller(client, inPeriod);

    const lines = [
      `${inPeriod.length} cancelled order(s) in ${periodLabel}, ` +
        `worth ${inr(total)}.`,
      "",
      "By reseller:",
      ...byReseller.map(
        ([name, orders]) =>
          `- ${name}: ${orders.length} (${inr(
            orders.reduce((s, o) => s + o.total, 0)
          )})`
      ),
    ];

    // Only worth spelling out when it isn't all one status.
    if (byStatus.size > 1) {
      lines.push(
        "",
        "By status:",
        ...[...byStatus].map(([status, n]) => `- ${status}: ${n}`)
      );
    }

    lines.push(
      "",
      "Read from WooCommerce, which is the only place cancellations are " +
        "recorded — the database still shows these orders at their last " +
        "fulfilment stage."
    );
    return lines.join("\n");
  });
}

/**
 * Cancelled orders grouped by reseller, using the same account grouping the
 * reports use, so a reseller filing under two shop names is counted once.
 */
async function splitByReseller(
  client: { query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }> },
  orders: WooCalledOffOrder[]
): Promise<[string, WooCalledOffOrder[]][]> {
  const candidates = await loadCandidates(client, orders);
  const groups = new Map<string, WooCalledOffOrder[]>();
  for (const o of orders) {
    const name = candidateFor(candidates, o)?.name ?? o.reseller_name ?? "(unknown)";
    const list = groups.get(name);
    if (list) list.push(o);
    else groups.set(name, [o]);
  }
  return [...groups].sort((a, b) => b[1].length - a[1].length);
}

/** The reseller a called-off order belongs to: by any name, or any number. */
function candidateFor(
  candidates: Candidate[],
  o: WooCalledOffOrder
): Candidate | undefined {
  const spelling = normalizeName(o.reseller_name ?? "");
  const number = normalizeNumber(o.reseller_number ?? "");
  return candidates.find(
    (c) =>
      (spelling && c.spellings.includes(spelling)) ||
      (number && c.numbers.includes(number))
  );
}

/**
 * The reseller accounts in the data, including these called-off orders, so an
 * order whose only trace is in WooCommerce still finds its reseller.
 */
async function loadCandidates(
  client: { query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }> },
  orders: WooCalledOffOrder[]
): Promise<Candidate[]> {
  const q = await client.query(
    `select coalesce(reseller_name,'')   as name,
            coalesce(reseller_number,'') as number,
            count(*)::int                as orders
       from public.orders
      where btrim(coalesce(reseller_name,'')) <> ''
         or btrim(coalesce(reseller_number,'')) <> ''
      group by 1, 2`
  );
  const rows = (q.rows as Record<string, unknown>[]).map((r) => ({
    name: String(r.name ?? ""),
    number: String(r.number ?? ""),
    orders: Number(r.orders),
  }));
  for (const o of orders) {
    rows.push({
      name: o.reseller_name ?? "",
      number: o.reseller_number ?? "",
      orders: 1,
    });
  }
  return groupResellers(rows.filter((r) => r.name || r.number));
}

function countBy<T>(items: T[], key: (t: T) => string): Map<string, number> {
  const out = new Map<string, number>();
  for (const it of items) {
    const k = key(it);
    out.set(k, (out.get(k) ?? 0) + 1);
  }
  return out;
}

function inr(v: number): string {
  return "₹" + v.toLocaleString("en-IN", { maximumFractionDigits: 2 });
}
