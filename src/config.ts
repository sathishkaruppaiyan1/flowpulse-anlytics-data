import "dotenv/config";

function required(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === "") {
    throw new Error(`Missing required env var: ${name}. See .env.example`);
  }
  return v;
}

function optionalNumber(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function requiredConfigured(name: string, value: string): string {
  if (!value || value.trim() === "") {
    throw new Error(`Missing required env var: ${name}. See .env.example`);
  }
  return value;
}

export const config = {
  telegramToken: required("TELEGRAM_BOT_TOKEN"),
  // Any OpenAI-compatible LLM endpoint (Groq, DeepInfra, Together, OpenRouter, Ollama).
  llmApiKey: required("LLM_API_KEY"),
  llmBaseUrl: process.env.LLM_BASE_URL || "https://api.groq.com/openai/v1",
  llmModel: process.env.LLM_MODEL || "qwen-2.5-coder-32b",
  // Simple mode: one Supabase/Postgres connection the bot reads directly.
  // Kept for backward compatibility; treated as the "blacklovers" database.
  dataDbUrl: process.env.DATA_DB_URL || "",
  // Multi-tenant mode only (optional): control-plane DB + credential encryption.
  controlDbUrl: process.env.CONTROL_DB_URL || "",
  encryptionKey: process.env.ENCRYPTION_KEY || "",
  queryRowLimit: optionalNumber("QUERY_ROW_LIMIT", 500),
  queryTimeoutMs: optionalNumber("QUERY_TIMEOUT_MS", 15000),
  // Optional business glossary: plain-English definitions mapping the user's
  // terms (e.g. "tracking stage") to concrete SQL rules. Injected into the
  // NL->SQL prompt so the model understands domain-specific language.
  businessGlossary: process.env.BUSINESS_GLOSSARY || "",
} as const;

/** A named database the simple-mode bot can route questions to. */
export interface DbConfig {
  key: string;
  label: string;
  url: string;
}

/**
 * The databases configured for simple mode, in menu order. The first is the
 * default/primary store. Reseller is added only when its URL is set, so a
 * single-DB deploy keeps working unchanged.
 *   DATA_DB_URL / DATA_DB_URL_BLACKLOVERS -> Blacklovers
 *   DATA_DB_URL_RESELLER                  -> Reseller
 */
export function configuredDatabases(): DbConfig[] {
  const list: DbConfig[] = [];
  const blacklovers =
    process.env.DATA_DB_URL_BLACKLOVERS || process.env.DATA_DB_URL || "";
  if (blacklovers.trim())
    list.push({ key: "blacklovers", label: "Blacklovers", url: blacklovers });

  const reseller = process.env.DATA_DB_URL_RESELLER || "";
  if (reseller.trim())
    list.push({ key: "reseller", label: "Reseller", url: reseller });

  return list;
}

export function requireSimpleConfig(): void {
  if (configuredDatabases().length === 0) {
    throw new Error(
      "No database configured. Set DATA_DB_URL (Blacklovers) and optionally " +
        "DATA_DB_URL_RESELLER. See .env.example"
    );
  }
}

export function requireMultiTenantConfig(): void {
  requiredConfigured("CONTROL_DB_URL", config.controlDbUrl);
  requiredConfigured("ENCRYPTION_KEY", config.encryptionKey);
}
