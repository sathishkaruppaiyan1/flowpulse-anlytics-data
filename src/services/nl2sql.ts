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
- If the question cannot be answered from the schema, output exactly: -- CANNOT_ANSWER

Text matching:
- When filtering by a name the user mentions (product, customer, category, etc.),
  use case-insensitive partial matching: WHERE col ILIKE '%term%'. Do NOT use
  exact equality (= 'term'), because stored names often include sizes, colors,
  or variants (e.g. 'Kolam Anarkali - 2XL, Maroon' contains 'anarkali').

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
