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

## Reseller Reports (PDF / CSV)

Name a reseller and (optionally) a period, and the bot replies with a chat
summary plus **both a PDF and a CSV** - no need to ask for a format:

- `dreamcouture last month orders`
- `minikki complete details`
- `shiny june 2025 orders`

Reseller names are matched fuzzily, so `dreamcouture` finds `Dreams couture`.

A report covers the **account**, not the name typed. Two records belong to the
same reseller when they share a name *or* share a `reseller_number`, followed
transitively, because neither field is reliable on its own:

- one account files orders under more than one shop name - `Cod Corner` and
  `Dreams couture` are the same person, so asking for either returns all 2,051
  of their orders
- one shop types its number inconsistently - `Be Legend Collection` appears
  under four numbers and is still one reseller
- spellings and generic shop words are folded together: `Cod Corner` / `Cod
  corner`, `Shiny` / `Shiny boutique`
- orders with a number but no name at all still land in the right report

Every name the report swept in is listed in the summary ("Also includes orders
placed under: ..."), so a total is never quietly larger than the name suggests.
When the name is unclear the bot offers the known resellers as buttons.

Each report contains:

- **Summary** - date range, total and net order count and value
- **Orders by status** - counts and value per status, cancelled ones flagged
- **Order details** - one row per product per order: S.No, order ID, product
  photo, product, customer name, customer phone, size / qty, price, status.
  S.No counts **orders, not lines**: an order with two products fills two rows
  under one number, with the order id, customer and phone shown once, so a
  two-product order no longer reads as two orders
- **Cancelled orders** - the cancelled ones again on their own, when there are any

Cancelled orders (status matching cancel / refund / return / failed / rejected)
are highlighted in red in the PDF and carry a `cancelled` column in the CSV.
Every total is reported both gross and **net of cancellations** - the net figure
is the one to bill on.

Orders are read from `public.orders` **union** `public.completed_orders`, since
finished orders are moved into that archive and a report reading only the live
table silently loses them, **union WooCommerce's cancelled / refunded / failed
orders**, fetched live from the store's REST API.

That last source is not an optimisation, it is the only way to be right about
cancellations. The importer that fills the database is one-way: it pushes
fulfilment stages *into* WooCommerce and never reads a status change back, so
`orders.status` only ever holds `processing` / `packing` / `packed` / `shipped`.
An order cancelled in WooCommerce therefore either keeps whatever stage it had
when it was cancelled, or - if it was already cancelled when the importer first
saw it - never reaches the database at all. Reports overlay the store's own
called-off list to correct the first case and add back the second.

Credentials come from the `public.woocommerce_settings` row the importer already
uses; no extra configuration. The list is cached for five minutes, and if the
store can't be reached the report is built from the database alone - the same
numbers as before, never worse.

Asking about cancellations in passing ("how many cancelled orders are there?")
is answered from the same WooCommerce list rather than by generated SQL, which
would otherwise answer 0 every time for the reason above. Questions about
anything else go to the normal question pipeline untouched.

Product photos are downscaled to thumbnails and cached on disk, so a report of
900 orders fetches roughly 90 distinct images once and reuses them.

Periods understood: `today`, `yesterday`, `this/last week`, `this/last month`,
`last 30 days`, `june 2025`, `2025`, `2026-01-01 to 2026-03-31`. With no period
the report covers all time. Period boundaries use `REPORT_TZ_OFFSET`
(default `+05:30`, IST).

These reports are built from fixed SQL rather than LLM-generated SQL, so the
totals are reproducible. They run against the reseller database when
`DATA_DB_URL_RESELLER` is set.

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
| Reseller PDF/CSV reports | `src/services/resellerReport.ts`, `src/services/pdf.ts`, `src/services/dateRange.ts` |
| WooCommerce cancellation overlay | `src/services/wooStatus.ts`, `src/services/cancelledAsk.ts` |
| Product photo thumbnails | `src/services/productImages.ts` |
| Report fonts (rupee sign, Tamil) | `assets/fonts/` |
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
