// WooCommerce is the only place that knows an order was called off.
//
// The database these reports read is fed by a one-way importer: it pushes
// fulfilment stages INTO WooCommerce (public.woo_sync_queue.target_status) and
// never reads a status change back. public.orders.status therefore only ever
// holds the fulfilment stage - processing / packing / packed / shipped - and an
// order cancelled in WooCommerce either keeps whatever stage it happened to
// have when it was cancelled, or, when it was already cancelled the first time
// the importer saw it, never lands in the database at all. Both make a report
// overstate orders and revenue, and neither is visible from SQL alone.
//
// Called-off orders are a tiny slice of the store (12 of ~4,250 when this was
// written), so the complete set fits in a handful of API calls. Reports fetch
// it and overlay it on the SQL rather than trusting a status that, for these
// orders, can never become correct.
//
// Everything here fails soft: no credentials, an unreachable store or a bad
// response all yield an empty list, and the report is then exactly as accurate
// as it was before - never less.

/** The statuses that mean an order was called off, as WooCommerce spells them. */
const CALLED_OFF_STATUSES = ["cancelled", "refunded", "failed"] as const;

const PAGE_SIZE = 100;
/** Stops a misbehaving store from being paged through forever. */
const MAX_PAGES = 20;
const FETCH_TIMEOUT_MS = 15_000;
const CACHE_TTL_MS = 5 * 60_000;
/** After a failure, wait before hammering the store again. */
const FAILURE_TTL_MS = 60_000;

/** A product line, shaped like the `line_items` jsonb stored in the database. */
export interface WooLineItem {
  name: string;
  size: string;
  price: number;
  total: number;
  quantity: number;
  /** Plain URL: WooCommerce nests this under `image.src`, the database doesn't. */
  image: string;
}

/** One called-off order, shaped like a row of the report's order source. */
export interface WooCalledOffOrder {
  order_number: string;
  status: string;
  total: number;
  /** UTC, from `date_created_gmt` - the store's own field is local time. */
  created_at: string;
  customer_name: string;
  customer_phone: string;
  reseller_name: string;
  /** The reseller's own phone number: which account placed the order. */
  reseller_number: string;
  line_items: WooLineItem[];
}

/** Just enough of a pg client for this module, so callers can pass either one. */
interface QueryableClient {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
}

interface StoreSettings {
  storeUrl: string;
  consumerKey: string;
  consumerSecret: string;
}

interface CacheEntry {
  at: number;
  ttl: number;
  orders: WooCalledOffOrder[];
}

const cache = new Map<string, CacheEntry>();

/**
 * Every order WooCommerce considers cancelled, refunded or failed, keyed by
 * nothing - the caller hands the whole list to SQL as jsonb. Returns an empty
 * list when the store can't be reached or isn't configured.
 */
export async function loadCalledOffOrders(
  client: QueryableClient
): Promise<WooCalledOffOrder[]> {
  const settings = await readSettings(client);
  if (!settings) return [];

  const cached = cache.get(settings.storeUrl);
  if (cached && Date.now() - cached.at < cached.ttl) return cached.orders;

  try {
    const orders: WooCalledOffOrder[] = [];
    for (const status of CALLED_OFF_STATUSES) {
      orders.push(...(await fetchByStatus(settings, status)));
    }
    cache.set(settings.storeUrl, { at: Date.now(), ttl: CACHE_TTL_MS, orders });
    return orders;
  } catch (e) {
    console.error("[report] WooCommerce cancelled-order lookup failed:", e);
    // Cache the failure briefly so one outage doesn't slow every report.
    cache.set(settings.storeUrl, { at: Date.now(), ttl: FAILURE_TTL_MS, orders: [] });
    return [];
  }
}

/** Forget cached results - for tests and for a forced refresh. */
export function clearWooCache(): void {
  cache.clear();
}

/**
 * The store's API credentials, as the importer itself stores them. Databases
 * that aren't the reseller store have no such table, which is not an error.
 */
async function readSettings(client: QueryableClient): Promise<StoreSettings | null> {
  try {
    const r = await client.query(
      `select store_url, consumer_key, consumer_secret
         from public.woocommerce_settings
        where coalesce(store_url,'') <> ''
          and coalesce(consumer_key,'') <> ''
          and coalesce(consumer_secret,'') <> ''
        order by updated_at desc nulls last
        limit 1`
    );
    const row = r.rows[0] as Record<string, string> | undefined;
    if (!row) return null;
    return {
      storeUrl: String(row.store_url).replace(/\/+$/, ""),
      consumerKey: String(row.consumer_key),
      consumerSecret: String(row.consumer_secret),
    };
  } catch {
    return null;
  }
}

/** Every order in one status, following WooCommerce's paging headers. */
async function fetchByStatus(
  s: StoreSettings,
  status: string
): Promise<WooCalledOffOrder[]> {
  const auth =
    "Basic " +
    Buffer.from(`${s.consumerKey}:${s.consumerSecret}`).toString("base64");
  const out: WooCalledOffOrder[] = [];

  for (let page = 1; page <= MAX_PAGES; page++) {
    const url =
      `${s.storeUrl}/wp-json/wc/v3/orders` +
      `?status=${encodeURIComponent(status)}&per_page=${PAGE_SIZE}&page=${page}` +
      `&orderby=date&order=desc`;
    const res = await fetch(url, {
      headers: { Authorization: auth },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new Error(`${status} page ${page}: HTTP ${res.status} ${res.statusText}`);
    }
    const batch = (await res.json()) as Record<string, unknown>[];
    if (!Array.isArray(batch) || batch.length === 0) break;
    for (const o of batch) out.push(toOrder(o));

    const totalPages = Number(res.headers.get("x-wp-totalpages") ?? "1");
    if (!Number.isFinite(totalPages) || page >= totalPages) break;
  }
  return out;
}

/** One WooCommerce order in the shape the report's SQL reads. */
function toOrder(o: Record<string, any>): WooCalledOffOrder {
  const billing = (o.billing ?? {}) as Record<string, string>;
  const name = `${billing.first_name ?? ""} ${billing.last_name ?? ""}`.trim();
  return {
    order_number: String(o.id),
    status: String(o.status ?? ""),
    total: Number(o.total ?? 0),
    // date_created is the store's local clock; the database holds UTC.
    created_at: o.date_created_gmt
      ? `${o.date_created_gmt}Z`
      : String(o.date_created ?? ""),
    // Matches the "Name :" prefix the report strips from stored rows.
    customer_name: name.replace(/^\s*Name\s*:\s*/i, ""),
    customer_phone: String(billing.phone ?? ""),
    reseller_name: metaValue(o.meta_data, ["billing_resllername", "billing_resellername"]),
    reseller_number: metaValue(o.meta_data, [
      "billing_resellernumber",
      "billing_resllernumber",
    ]),
    line_items: (o.line_items ?? []).map(toLineItem),
  };
}

function toLineItem(item: Record<string, any>): WooLineItem {
  return {
    name: String(item.name ?? ""),
    // Size lives in line-item meta, under the attribute slug.
    size: metaValue(item.meta_data, ["pa_size", "size"]),
    price: Number(item.price ?? 0),
    total: Number(item.total ?? 0),
    quantity: Number(item.quantity ?? 0),
    image: String(item.image?.src ?? ""),
  };
}

/**
 * A meta value by key, ignoring the leading underscore WooCommerce puts on the
 * private copy of each field. Note the store's own misspelling,
 * `billing_resllername`, which is the key the reseller name actually lives in.
 */
function metaValue(meta: unknown, keys: string[]): string {
  if (!Array.isArray(meta)) return "";
  const wanted = new Set(keys.map((k) => k.toLowerCase()));
  for (const entry of meta as Record<string, unknown>[]) {
    const key = String(entry?.key ?? "")
      .toLowerCase()
      .replace(/^_/, "");
    const displayKey = String(entry?.display_key ?? "").toLowerCase();
    if (!wanted.has(key) && !wanted.has(displayKey)) continue;
    const value = entry?.value ?? entry?.display_value;
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}
