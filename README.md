# Supabase Analytics Bot

A Telegram bot that answers plain-English analytics questions over a Supabase or PostgreSQL database.

The project supports two modes:

- Simple single-DB mode: one database connection from `DATA_DB_URL`. This is the mode to use first.
- Multi-tenant mode: Telegram users can connect multiple Supabase projects, with encrypted credentials and a control-plane database.

## Simple Mode Setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Copy the environment file:

   ```bash
   cp .env.example .env
   ```

3. Fill these values in `.env`:

   ```bash
   TELEGRAM_BOT_TOKEN=
   LLM_API_KEY=
   LLM_BASE_URL=https://api.groq.com/openai/v1
   LLM_MODEL=qwen-2.5-coder-32b
   DATA_DB_URL=postgresql://readonly_bot:password@host:5432/postgres
   ```

4. Make sure `DATA_DB_URL` uses a read-only database role.
   For Supabase, you can adapt `client-setup/readonly-role.sql`.

5. Run the simple bot:

   ```bash
   npm run simple
   ```

## Simple Bot Commands

- `/start` - intro
- `/schema` - show tables and columns
- `/refresh` - re-read the database schema
- `/help` - show help

After startup, just send a question like:

- `how many rows are in each table?`
- `total sales this month`
- `top 5 customers by orders`

## How It Works

```text
Telegram -> Bot backend -> LLM generates SQL -> SQL guard -> Read-only Postgres query -> LLM summary
```

The safety model uses:

- A read-only database role
- A session-level read-only setting
- A SELECT-only SQL guard
- Query row limits
- Statement timeouts

## Architecture

| Layer | File(s) |
|-------|---------|
| Config / env | `src/config.ts`, `.env.example` |
| Simple bot entry | `src/simple.ts` |
| Multi-tenant bot entry | `src/index.ts`, `src/bot/bot.ts` |
| Question pipeline | `src/services/simpleAsk.ts`, `src/services/ask.ts` |
| NL to SQL + summary | `src/services/nl2sql.ts` |
| SQL safety guard | `src/services/sqlGuard.ts` |
| Read-only executor | `src/services/executor.ts`, `src/services/clientDb.ts` |
| Schema introspection | `src/services/schemaIntrospect.ts` |
| Tenant/project store | `src/services/projectStore.ts` |
| Credential encryption | `src/crypto/vault.ts` |

## Multi-Tenant Mode

Use this later when you want each Telegram user to connect one or more Supabase projects.

Additional `.env` values required:

```bash
CONTROL_DB_URL=postgresql://user:password@host:5432/postgres
ENCRYPTION_KEY=64_hex_character_key
```

Initialize the control-plane database:

```bash
npm run db:init
```

Run multi-tenant mode:

```bash
npm run dev
```

Production:

```bash
npm run build
npm start
```

## Multi-Tenant Commands

- `/start` - intro
- `/connect <label>` - add a Supabase project
- `/projects` - list connected projects
- `/use <id>` - switch active project
- `/schema` - show tables in the active project
- `/refresh` - re-read the active project schema
- `/help` - show help

## Notes

Client credentials in multi-tenant mode are encrypted with AES-256-GCM and stored only in your control-plane database. Client table data is not stored by the bot; only questions, generated SQL, row counts, status, and errors are logged.
