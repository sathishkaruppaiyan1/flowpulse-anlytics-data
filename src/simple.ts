// ---------------------------------------------------------------------------
// SIMPLE MODE entry point.
// One or two Supabase connections (DATA_DB_URL / DATA_DB_URL_RESELLER).
// No control-plane DB. Run with: npm run simple
//
// With two databases configured, each question is answered against EXACTLY one
// of them, never both. The bot auto-routes when the question clearly names a
// store (e.g. "reseller sales") and otherwise asks with inline buttons.
// ---------------------------------------------------------------------------
import { Bot, InlineKeyboard, InputFile, type Context } from "grammy";
import http from "node:http";
import { config, requireSimpleConfig, configuredDatabases } from "./config.js";
import {
  introspectSchema,
  schemaToPrompt,
  type TableInfo,
} from "./services/schemaIntrospect.js";
import { simpleAsk } from "./services/simpleAsk.js";
import { routeToDb } from "./services/dbRouter.js";
import {
  isCompleteDetailsRequest,
  buildResellerReport,
} from "./services/resellerReport.js";
import { renderValues, renderTable, asPre } from "./services/report.js";

interface Database {
  key: string;
  label: string;
  conn: string;
  tables: TableInfo[];
  schemaText: string;
}

async function main() {
  requireSimpleConfig();

  const bot = new Bot(config.telegramToken);
  const healthServer = startHealthServer();

  // Build the database registry from configured connections.
  const databases: Database[] = configuredDatabases().map((d) => ({
    key: d.key,
    label: d.label,
    conn: d.url,
    tables: [],
    schemaText: "(schema not loaded yet)",
  }));
  const byKey = new Map(databases.map((d) => [d.key, d]));
  const multiDb = databases.length > 1;

  // Pending question per chat, awaiting a "which database?" button tap.
  const pending = new Map<number, string>();

  async function loadSchemas(): Promise<void> {
    for (const db of databases) {
      db.tables = await introspectSchema(db.conn);
      db.schemaText = schemaToPrompt(db.tables);
      console.log(`[simple] ${db.label}: ${db.tables.length} table(s)`);
    }
  }

  console.log("[simple] reading database schema(s)...");
  await loadSchemas();

  await bot.api.setMyCommands([
    { command: "start", description: "Get started" },
    { command: "schema", description: "Show your tables" },
    { command: "refresh", description: "Re-read the schema" },
    { command: "help", description: "Show help" },
  ]);

  const dbListText = databases.map((d) => `- ${d.label}`).join("\n");

  bot.command("start", (ctx) =>
    ctx.reply(
      `Hi! I'm connected to ${databases.length} database${
        multiDb ? "s" : ""
      }:\n${dbListText}\n\n` +
        `Just ask me anything in plain English, e.g.:\n` +
        `- "total sales this month"\n` +
        `- "top 5 customers by orders"\n` +
        (multiDb
          ? `\nI answer from ONE database per question. Mention "reseller" to ` +
            `target that store; otherwise I'll ask which one.\n`
          : "") +
        `\nCommands: /schema, /refresh, /help`
    )
  );

  bot.command("help", (ctx) =>
    ctx.reply(
      `Ask any analytical question in plain English.\n` +
        (multiDb
          ? `I use one database per question (never combined). Say "reseller" ` +
            `to target the reseller store; otherwise I'll ask which one.\n`
          : "") +
        `/schema - see your tables and columns\n` +
        `/refresh - re-read the schema after DB changes`
    )
  );

  bot.command("schema", async (ctx) => {
    for (const db of databases) {
      const header = multiDb ? `${db.label}:\n` : "";
      await ctx.reply(header + asPre(db.schemaText), { parse_mode: "HTML" });
    }
  });

  bot.command("refresh", async (ctx) => {
    try {
      await loadSchemas();
      const summary = databases
        .map((d) => `${d.label}: ${d.tables.length}`)
        .join(", ");
      await ctx.reply(`Schema refreshed (${summary} table(s)).`);
    } catch (e) {
      await ctx.reply(`Refresh failed: ${(e as Error).message}`);
    }
  });

  /** Run a question against ONE database and reply, tagged with its label. */
  async function answerWith(
    ctx: Context,
    db: Database,
    question: string
  ): Promise<void> {
    await ctx.replyWithChatAction("typing");
    const result = await simpleAsk(db.conn, db.schemaText, question);
    const tag = multiDb ? `[${db.label}] ` : "";

    if (!result.ok) {
      await ctx.reply(`${tag}Warning: ${result.error}`);
      return;
    }
    await ctx.reply(`${tag}${result.answer!}`);
    if (result.output && result.output.rows.length > 0) {
      if (result.output.rows.length === 1) {
        await ctx.reply(renderValues(result.output));
      } else {
        await ctx.reply(asPre(renderTable(result.output)), { parse_mode: "HTML" });
      }
    }
  }

  // The reseller store to run "complete details" reports against: the Reseller
  // DB if configured, else the only database.
  const reportDb = byKey.get("reseller") ?? databases[0];

  /** Generate a reseller complete-details report: text summary + CSV file. */
  async function sendResellerReport(ctx: Context, question: string): Promise<void> {
    await ctx.replyWithChatAction("typing");
    const tag = multiDb ? `[${reportDb.label}] ` : "";
    try {
      const report = await buildResellerReport(reportDb.conn, question);
      await ctx.reply(`${tag}${report.summaryText}`);
      if (report.found && report.csv && report.filename) {
        await ctx.replyWithDocument(
          new InputFile(Buffer.from(report.csv, "utf8"), report.filename)
        );
      }
    } catch (e) {
      await ctx.reply(`${tag}Couldn't build the report: ${(e as Error).message}`);
    }
  }

  /** Show the "which database?" buttons and remember the pending question. */
  async function askWhichDb(ctx: Context, question: string): Promise<void> {
    if (!ctx.chat) return;
    pending.set(ctx.chat.id, question);
    const kb = new InlineKeyboard();
    for (const db of databases) kb.text(db.label, `db:${db.key}`);
    await ctx.reply("Which database should I check?", { reply_markup: kb });
  }

  // Button tap: resolve the pending question against the chosen database.
  bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data;
    if (!data.startsWith("db:")) {
      await ctx.answerCallbackQuery();
      return;
    }
    const db = byKey.get(data.slice(3));
    const chatId = ctx.chat?.id;
    const question = chatId != null ? pending.get(chatId) : undefined;

    await ctx.answerCallbackQuery();
    if (!db) return;
    if (!question) {
      await ctx.editMessageText("That question expired — please ask again.");
      return;
    }
    if (chatId != null) pending.delete(chatId);
    await ctx.editMessageText(`Checking ${db.label}...`);
    await answerWith(ctx, db, question);
  });

  bot.on("message:text", async (ctx) => {
    const text = ctx.message.text;
    if (text.startsWith("/")) return;

    // "complete details" -> deterministic reseller report (text + CSV).
    if (isCompleteDetailsRequest(text)) {
      await sendResellerReport(ctx, text);
      return;
    }

    // Single database: answer directly.
    if (!multiDb) {
      await answerWith(ctx, databases[0], text);
      return;
    }

    // Two databases: auto-route when clear, otherwise ask.
    const key = routeToDb(text);
    const db = key ? byKey.get(key) : undefined;
    if (db) {
      await answerWith(ctx, db, text);
      return;
    }
    await askWhichDb(ctx, text);
  });

  const shutdown = async () => {
    console.log("\n[simple] shutting down...");
    await bot.stop();
    await new Promise<void>((resolve) => {
      if (!healthServer) {
        resolve();
        return;
      }
      healthServer.close(() => resolve());
    });
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  console.log("[simple] starting (long polling)...");
  await bot.start({
    onStart: (info) => console.log(`[simple] running as @${info.username}`),
  });
}

function startHealthServer(): http.Server | null {
  const port = Number(process.env.PORT || process.env.HEALTH_PORT || 0);
  if (!Number.isInteger(port) || port <= 0) return null;

  const server = http.createServer((req, res) => {
    if (req.url === "/health" || req.url === "/") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
      return;
    }

    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  });

  server.listen(port, () => {
    console.log(`[simple] health server listening on port ${port}`);
  });
  return server;
}

main().catch((err) => {
  console.error("[simple] fatal:", err);
  process.exit(1);
});
