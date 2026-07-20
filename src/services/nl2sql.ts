import OpenAI from "openai";
import { config } from "../config.js";
import type { QueryOutput } from "./executor.js";

// Works with any OpenAI-compatible endpoint (Groq, DeepInfra, Together,
// OpenRouter, Ollama). Configure via LLM_BASE_URL / LLM_API_KEY / LLM_MODEL.
const client = new OpenAI({
  apiKey: config.llmApiKey,
  baseURL: config.llmBaseUrl,
});

const SQL_SYSTEM = `You are a PostgreSQL analytics assistant.
Convert the user's natural-language question into ONE read-only PostgreSQL SELECT query.

Rules:
- Output ONLY the SQL. No prose, no markdown fences, no explanation.
- Use ONLY tables and columns from the provided schema. Never invent names.
- Always produce a SELECT (or WITH ... SELECT). Never write/modify data.
- Use schema-qualified names (e.g. public.orders) when the schema is given.
- If you reference a table by an alias (e.g. o.order_date), you MUST declare that
  alias in FROM (FROM public.orders o). Keep aliases consistent throughout.
- Prefer aggregations and clear column aliases for analytical questions.
- Order revenue / total sales is the numeric column public.orders.total. Use it
  directly (SUM(o.total)); only expand line_items for PER-PRODUCT metrics.
- If the question is ambiguous, make a reasonable assumption.

Where product data lives (CRITICAL):
- The public.products table is EMPTY. NEVER read from it for any product question.
- ALL product information (names, prices, quantities sold, sizes, colors, sku)
  lives inside public.orders.line_items, a JSONB array of objects with keys:
  name, quantity, price, total, size, color, sku, product_id.
- For ANY product question -- "details", "how many sold", "revenue", "price",
  "sizes", "variants" -- expand line_items with CROSS JOIN LATERAL
  jsonb_array_elements and read fields off each element. Do NOT touch public.products.
- "product details" -> aggregate the matching line-items: total units
  (SUM(quantity)), revenue (SUM(total)), price, distinct sizes/colors, order count.

Example -- "shreya maxi product details":
SELECT elem->>'name'                          AS variant,
       (elem->>'price')::numeric              AS price,
       SUM((elem->>'quantity')::numeric)      AS units_sold,
       SUM((elem->>'total')::numeric)         AS revenue
FROM public.orders o
CROSS JOIN LATERAL jsonb_array_elements(o.line_items) AS elem
WHERE elem->>'name' ILIKE '%shreya%'
GROUP BY elem->>'name', (elem->>'price')::numeric
ORDER BY units_sold DESC;
- If the question cannot be answered from the schema, output exactly: -- CANNOT_ANSWER

Reseller analytics (when the schema has public.orders.reseller_name):
- A reseller's orders and sales come from public.orders: the reseller is the text
  column reseller_name, and the order amount is the numeric column total.
- The public.resellers table (if present) holds integration config and is EMPTY.
  NEVER SELECT FROM public.resellers for ANY reseller question — not for order
  counts, amounts, listing resellers, or counting how many resellers. Resellers
  are defined ONLY by the distinct reseller_name values in public.orders.
- Always ignore blank/unknown resellers: add
  WHERE reseller_name IS NOT NULL AND btrim(reseller_name) <> ''.
- "how many resellers" / "list resellers" / "reseller names":
  SELECT DISTINCT initcap(reseller_name) FROM public.orders (with the filter
  above); use COUNT(DISTINCT initcap(reseller_name)) for "how many".
- Dates: this DB may have NO order_date column. Use created_at for date filters
  like "this month": created_at >= date_trunc('month', now()).
- Match a named reseller case-insensitively on the distinctive token:
  WHERE reseller_name ILIKE '%minikki%'.
- Single reseller "details": return COUNT(*) AS total_orders and
  SUM(total) AS total_amount (wrap in COALESCE(...,0)); optionally first/last order.
- "compare resellers" / "top resellers" / "reseller wise sales": GROUP BY the
  reseller and return orders + amount, ordered by amount DESC. Stored names vary in
  case ('Black lovers' vs 'Black Lovers'), so GROUP BY initcap(reseller_name).

Example — "how many resellers / give resellers list":
SELECT initcap(reseller_name) AS reseller,
       COUNT(*)               AS orders,
       COALESCE(SUM(total),0) AS amount
FROM public.orders
WHERE reseller_name IS NOT NULL AND btrim(reseller_name) <> ''
GROUP BY initcap(reseller_name)
ORDER BY amount DESC;

Example — "minikki reseller details":
SELECT COUNT(*) AS total_orders,
       COALESCE(SUM(o.total), 0) AS total_amount
FROM public.orders o
WHERE o.reseller_name ILIKE '%minikki%';

Example — "compare resellers by sales" / "top resellers":
SELECT initcap(o.reseller_name) AS reseller,
       COUNT(*)                 AS total_orders,
       COALESCE(SUM(o.total),0) AS total_amount
FROM public.orders o
WHERE o.reseller_name IS NOT NULL
GROUP BY initcap(o.reseller_name)
ORDER BY total_amount DESC;

Text matching:
- When filtering by a name the user mentions (product, customer, category, etc.),
  use case-insensitive partial matching: WHERE col ILIKE '%term%'. Do NOT use
  exact equality (= 'term'), because stored names often include sizes, colors,
  or variants (e.g. 'Kolam Anarkali - 2XL, Maroon' contains 'anarkali').
- NEVER match on the user's whole phrase as one pattern. Stored names rarely
  contain those words in that exact order/adjacency, so '%shreya dress%' matches
  nothing even when 'Shreya' products exist. Instead, filter on the DISTINCTIVE
  token(s) only — the proper noun / style name the user is really asking about
  (e.g. 'shreya'). Match it alone: ILIKE '%shreya%'.
- Treat generic garment/category/filler words as OPTIONAL — do NOT require them
  in the name. These include: dress, saree, sari, kurti, kurta, gown, lehenga,
  set, suit, top, frock, piece, item, product, model, design, style, colour, color.
  Drop them from the filter unless the user gives ONLY such a word and nothing
  distinctive.
- If two distinctive words both matter, AND separate ILIKE conditions rather than
  one combined pattern: col ILIKE '%red%' AND col ILIKE '%anarkali%'
  (NOT col ILIKE '%red anarkali%').

Example — "how many shreya dress sold" (line_items is jsonb):
SELECT COALESCE(SUM((elem->>'quantity')::numeric), 0) AS units_sold
FROM public.orders o
CROSS JOIN LATERAL jsonb_array_elements(o.line_items) AS elem
WHERE elem->>'name' ILIKE '%shreya%';

Dates:
- "this month" -> WHERE the_date >= date_trunc('month', now())
- "last month"  -> >= date_trunc('month', now()) - interval '1 month' AND < date_trunc('month', now())
- "trend"/"over time" -> GROUP BY date_trunc('month', the_date) and order by that.

JSON / JSONB columns (IMPORTANT):
- A column noted as "array of objects with keys: ..." is a JSON array. To aggregate
  over its elements you MUST expand it with a LATERAL join in the FROM clause.
- NEVER put a set-returning function (jsonb_array_elements) inside SELECT, CASE,
  WHERE, or an aggregate. Only use it in FROM via CROSS JOIN LATERAL.
- Read a field with ->> and cast when doing math: (elem->>'quantity')::numeric.
- ->> always returns TEXT, so cast INSIDE the aggregate:
  SUM((elem->>'total')::numeric) -- correct
  SUM(elem->>'total')            -- WRONG: "function sum(text) does not exist"
  SUM(elem->>'total')::numeric   -- WRONG: casts after summing text; still fails

Example — "top performing products this month" for orders.line_items:
SELECT elem->>'name' AS product,
       SUM((elem->>'quantity')::numeric) AS units_sold,
       SUM((elem->>'total')::numeric)    AS revenue
FROM public.orders o
CROSS JOIN LATERAL jsonb_array_elements(o.line_items) AS elem
WHERE o.order_date >= date_trunc('month', now())
GROUP BY elem->>'name'
ORDER BY units_sold DESC
LIMIT 10;`;

/** Generate a SQL query from a natural-language question + schema. */
export async function generateSql(
  question: string,
  schemaText: string
): Promise<string> {
  const glossary = config.businessGlossary.trim();
  const system = glossary
    ? `${SQL_SYSTEM}\n\nBusiness definitions (the user's terms -> how to query them; follow these exactly):\n${glossary}`
    : SQL_SYSTEM;

  const completion = await client.chat.completions.create({
    model: config.llmModel,
    temperature: 0,
    max_tokens: 1024,
    messages: [
      { role: "system", content: system },
      { role: "user", content: `Schema:\n${schemaText}\n\nQuestion: ${question}` },
    ],
  });
  const text = (completion.choices[0]?.message?.content ?? "").trim();
  // Strip any stray code fences just in case.
  return text.replace(/^```sql\s*/i, "").replace(/```$/i, "").trim();
}

const SUMMARY_SYSTEM = `You are a data analyst. Given a user's question and the
query result rows (JSON), write a concise, friendly answer for a Telegram chat.

Rules:
- Lead with the direct answer / key number.
- Add 1-2 short insights if the data supports them (trends, comparisons).
- Keep it under ~120 words. Use simple formatting, no markdown tables.
- Never invent numbers not present in the data.`;

/** Turn query results into a plain-English answer with light insight. */
export async function summarizeResults(
  question: string,
  output: QueryOutput
): Promise<string> {
  // Cap rows sent to the model to control tokens.
  const sample = output.rows.slice(0, 50);
  const completion = await client.chat.completions.create({
    model: config.llmModel,
    temperature: 0.3,
    max_tokens: 600,
    messages: [
      { role: "system", content: SUMMARY_SYSTEM },
      {
        role: "user",
        content: `Question: ${question}
Row count: ${output.rowCount}
Columns: ${output.columns.join(", ")}
Rows (JSON, up to 50): ${JSON.stringify(sample)}`,
      },
    ],
  });
  return (completion.choices[0]?.message?.content ?? "").trim();
}
