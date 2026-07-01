import { bot } from "./bot/bot.js";
import { requireMultiTenantConfig } from "./config.js";
import { controlPool } from "./db/control.js";

async function main() {
  requireMultiTenantConfig();

  // Verify control DB is reachable before starting.
  await controlPool.query("select 1");
  console.log("[bot] control DB connected");

  await bot.api.setMyCommands([
    { command: "start", description: "Get started" },
    { command: "connect", description: "Add a Supabase project" },
    { command: "projects", description: "List connected projects" },
    { command: "use", description: "Switch active project" },
    { command: "schema", description: "Show tables of active project" },
    { command: "refresh", description: "Re-read the schema" },
    { command: "help", description: "Show help" },
  ]);

  console.log("[bot] starting (long polling)...");
  await bot.start({
    onStart: (info) => console.log(`[bot] running as @${info.username}`),
  });
}

const shutdown = async () => {
  console.log("\n[bot] shutting down...");
  await bot.stop();
  await controlPool.end();
  process.exit(0);
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

main().catch((err) => {
  console.error("[bot] fatal:", err);
  process.exit(1);
});
