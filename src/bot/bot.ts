import { Bot } from "grammy";
import { config } from "../config.js";
import {
  getOrCreateTenant,
  addProject,
  listProjects,
  setActiveProject,
  getActiveProject,
} from "../services/projectStore.js";
import { getSchema, schemaToPrompt, refreshSchema } from "../services/schemaIntrospect.js";
import { ask } from "../services/ask.js";
import { renderTable, asPre } from "../services/report.js";

export const bot = new Bot(config.telegramToken);

// Small per-chat flag so /connect can capture the next message as the conn string.
const awaitingConn = new Map<number, string>(); // chatId -> label

function tenantName(from?: { first_name?: string; username?: string }): string {
  return from?.username || from?.first_name || "there";
}

bot.command("start", async (ctx) => {
  await getOrCreateTenant(ctx.from!.id, tenantName(ctx.from));
  await ctx.reply(
    `Hi ${tenantName(ctx.from)}! I turn plain-English questions into analytics over your Supabase database.\n\n` +
      `Get started:\n` +
      `1. /connect <label> - link a Supabase project (read-only)\n` +
      `2. /use - pick which project is active\n` +
      `3. Just ask me anything, e.g. "how many orders this month?"\n\n` +
      `Other commands: /projects, /schema, /refresh, /help`
  );
});

bot.command("help", async (ctx) => {
  await ctx.reply(
    `Commands:\n` +
      `/connect <label> - add a Supabase project (I'll ask for the read-only connection string)\n` +
      `/projects - list your connected projects\n` +
      `/use - switch the active project\n` +
      `/schema - show tables in the active project\n` +
      `/refresh - re-read the schema of the active project\n\n` +
      `Then just type a question in plain English.`
  );
});

bot.command("connect", async (ctx) => {
  const label = ctx.match?.trim();
  if (!label) {
    await ctx.reply("Usage: /connect <label>\nExample: /connect production");
    return;
  }
  awaitingConn.set(ctx.chat.id, label);
  await ctx.reply(
    `Send me the *read-only* connection string for "${label}".\n\n` +
      `Warning: Use a read-only role (see the setup SQL in the README), not your full credentials.\n` +
      `Format: postgresql://readonly_bot:PASSWORD@HOST:5432/postgres\n\n` +
      `Tip: delete the message after I confirm.`,
    { parse_mode: "Markdown" }
  );
});

bot.command("projects", async (ctx) => {
  const tenant = await getOrCreateTenant(ctx.from!.id, tenantName(ctx.from));
  const projects = await listProjects(tenant.id);
  if (projects.length === 0) {
    await ctx.reply("No projects yet. Add one with /connect <label>.");
    return;
  }
  const lines = projects
    .map((p) => `${p.is_active ? "[active]" : "[ ]"} ${p.label} (id ${p.id})`)
    .join("\n");
  await ctx.reply(`Your projects:\n${lines}\n\nSwitch with: /use <id>`);
});

bot.command("use", async (ctx) => {
  const tenant = await getOrCreateTenant(ctx.from!.id, tenantName(ctx.from));
  const id = Number(ctx.match?.trim());
  if (!Number.isInteger(id)) {
    const projects = await listProjects(tenant.id);
    const lines = projects.map((p) => `- ${p.label} -> /use ${p.id}`).join("\n");
    await ctx.reply(`Pick a project:\n${lines || "(none - use /connect first)"}`);
    return;
  }
  const changed = await setActiveProject(tenant.id, id);
  if (!changed) {
    await ctx.reply(`Project id ${id} was not found. Use /projects to see available projects.`);
    return;
  }
  await ctx.reply(`Active project set to id ${id}. Ask away!`);
});

bot.command("schema", async (ctx) => {
  const tenant = await getOrCreateTenant(ctx.from!.id, tenantName(ctx.from));
  const project = await getActiveProject(tenant.id);
  if (!project) {
    await ctx.reply("No active project. Use /connect then /use.");
    return;
  }
  try {
    const tables = await getSchema(project.id, tenant.id);
    await ctx.reply(asPre(schemaToPrompt(tables)), { parse_mode: "HTML" });
  } catch (e) {
    await ctx.reply(`Couldn't read schema: ${(e as Error).message}`);
  }
});

bot.command("refresh", async (ctx) => {
  const tenant = await getOrCreateTenant(ctx.from!.id, tenantName(ctx.from));
  const project = await getActiveProject(tenant.id);
  if (!project) {
    await ctx.reply("No active project.");
    return;
  }
  try {
    const tables = await refreshSchema(project.id, tenant.id);
    await ctx.reply(`Schema refreshed: ${tables.length} table(s) found.`);
  } catch (e) {
    await ctx.reply(`Refresh failed: ${(e as Error).message}`);
  }
});

// Free-text handler: either capture a pending connection string, or answer a question.
bot.on("message:text", async (ctx) => {
  const text = ctx.message.text;
  if (text.startsWith("/")) return;

  const tenant = await getOrCreateTenant(ctx.from!.id, tenantName(ctx.from));

  // Pending /connect: treat this message as the connection string.
  const pendingLabel = awaitingConn.get(ctx.chat.id);
  if (pendingLabel) {
    awaitingConn.delete(ctx.chat.id);
    if (!/^postgres(ql)?:\/\//i.test(text.trim())) {
      await ctx.reply("That doesn't look like a postgres:// connection string. Try /connect again.");
      return;
    }
    try {
      const project = await addProject(tenant.id, pendingLabel, text.trim());
      await refreshSchema(project.id, tenant.id); // validate + cache
      await ctx.reply(
        `Connected "${pendingLabel}"${project.is_active ? " (now active)" : ""}. ` +
          `You can ask questions now. Try /schema to see your tables.`
      );
    } catch (e) {
      await ctx.reply(
        `Couldn't connect: ${(e as Error).message}\n` +
          `Check the connection string and that the read-only role exists.`
      );
    }
    return;
  }

  await ctx.replyWithChatAction("typing");
  const result = await ask(tenant, text);

  if (!result.ok) {
    await ctx.reply(`Warning: ${result.error}`);
    return;
  }

  await ctx.reply(result.answer!);
  if (result.output && result.output.rows.length > 0) {
    await ctx.reply(asPre(renderTable(result.output)), { parse_mode: "HTML" });
  }
});
