// ---------------------------------------------------------------------------
// SIMPLE MODE entry point.
// One Supabase connection (DATA_DB_URL). No control-plane DB.
// Run with: npm run simple
// ---------------------------------------------------------------------------
import { Bot } from "grammy";
import http from "node:http";
import { config, requireSimpleConfig } from "./config.js";
import {
  introspectSchema,
  schemaToPrompt,
  type TableInfo,
} from "./services/schemaIntrospect.js";
import { simpleAsk } from "./services/simpleAsk.js";
import { renderTable, asPre } from "./services/report.js";

async function main() {
  requireSimpleConfig();

  const bot = new Bot(config.telegramToken);
  const healthServer = startHealthServer();

  // In-memory schema cache. Re-read with /refresh.
  let tables: TableInfo[] = [];
  let schemaText = "(schema not loaded yet)";

  async function loadSchema() {
    tables = await introspectSchema(config.dataDbUrl);
    schemaText = schemaToPrompt(tables);
    return tables.length;
  }

  console.log("[simple] reading database schema...");
  const count = await loadSchema();
  console.log(`[simple] loaded ${count} table(s)`);

  await bot.api.setMyCommands([
    { command: "start", description: "Get started" },
    { command: "schema", description: "Show your tables" },
    { command: "refresh", description: "Re-read the schema" },
    { command: "help", description: "Show help" },
  ]);

  bot.command("start", (ctx) =>
    ctx.reply(
      `Hi! I'm connected to your database (${tables.length} tables).\n\n` +
        `Just ask me anything in plain English, e.g.:\n` +
        `- "how many rows in each table?"\n` +
        `- "total sales this month"\n` +
        `- "top 5 customers by orders"\n\n` +
        `Commands: /schema, /refresh, /help`
    )
  );

  bot.command("help", (ctx) =>
    ctx.reply(
      `Ask any analytical question in plain English.\n` +
        `/schema - see your tables and columns\n` +
        `/refresh - re-read the schema after DB changes`
    )
  );

  bot.command("schema", (ctx) =>
    ctx.reply(asPre(schemaText), { parse_mode: "HTML" })
  );

  bot.command("refresh", async (ctx) => {
    try {
      const n = await loadSchema();
      await ctx.reply(`Schema refreshed: ${n} table(s) found.`);
    } catch (e) {
      await ctx.reply(`Refresh failed: ${(e as Error).message}`);
    }
  });

  bot.on("message:text", async (ctx) => {
    const text = ctx.message.text;
    if (text.startsWith("/")) return;

    await ctx.replyWithChatAction("typing");
    const result = await simpleAsk(config.dataDbUrl, schemaText, text);

    if (!result.ok) {
      await ctx.reply(`Warning: ${result.error}`);
      return;
    }
    await ctx.reply(result.answer!);
    if (result.output && result.output.rows.length > 0) {
      await ctx.reply(asPre(renderTable(result.output)), { parse_mode: "HTML" });
    }
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
