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
- Prefer aggregations and clear column aliases for analytical questions.
- If the question is ambiguous, make a reasonable assumption.
- If the question cannot be answered from the schema, output exactly: -- CANNOT_ANSWER`;

/** Generate a SQL query from a natural-language question + schema. */
export async function generateSql(
  question: string,
  schemaText: string
): Promise<string> {
  const completion = await client.chat.completions.create({
    model: config.llmModel,
    temperature: 0,
    max_tokens: 1024,
    messages: [
      { role: "system", content: SQL_SYSTEM },
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
