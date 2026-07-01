import { controlQuery } from "../db/control.js";
import { encrypt, decrypt } from "../crypto/vault.js";

export interface Tenant {
  id: number;
  telegram_user_id: number;
  display_name: string | null;
  plan: string;
}

export interface Project {
  id: number;
  tenant_id: number;
  label: string;
  is_active: boolean;
}

/** Get an existing tenant for a Telegram user, or create one. */
export async function getOrCreateTenant(
  telegramUserId: number,
  displayName?: string
): Promise<Tenant> {
  const { rows } = await controlQuery<Tenant>(
    `insert into tenants (telegram_user_id, display_name)
     values ($1, $2)
     on conflict (telegram_user_id)
       do update set display_name = coalesce(excluded.display_name, tenants.display_name)
     returning id, telegram_user_id, display_name, plan`,
    [telegramUserId, displayName ?? null]
  );
  return rows[0];
}

/** Add (or replace) a connected Supabase project for a tenant. */
export async function addProject(
  tenantId: number,
  label: string,
  connectionString: string
): Promise<Project> {
  const connEnc = encrypt(connectionString);
  const { rows } = await controlQuery<Project>(
    `insert into projects (tenant_id, label, conn_enc, is_active)
     values ($1, $2, $3, false)
     on conflict (tenant_id, label)
       do update set conn_enc = excluded.conn_enc
     returning id, tenant_id, label, is_active`,
    [tenantId, label, connEnc]
  );
  // If this is the tenant's only project, make it active automatically.
  const project = rows[0];
  const count = await controlQuery<{ c: string }>(
    `select count(*)::text as c from projects where tenant_id = $1`,
    [tenantId]
  );
  if (Number(count.rows[0].c) === 1) {
    await setActiveProject(tenantId, project.id);
    project.is_active = true;
  }
  return project;
}

export async function listProjects(tenantId: number): Promise<Project[]> {
  const { rows } = await controlQuery<Project>(
    `select id, tenant_id, label, is_active
     from projects where tenant_id = $1 order by created_at asc`,
    [tenantId]
  );
  return rows;
}

export async function setActiveProject(
  tenantId: number,
  projectId: number
): Promise<boolean> {
  const existing = await controlQuery<{ id: number }>(
    `select id from projects where tenant_id = $1 and id = $2`,
    [tenantId, projectId]
  );
  if (!existing.rows[0]) return false;

  await controlQuery(
    `update projects set is_active = (id = $2) where tenant_id = $1`,
    [tenantId, projectId]
  );
  return true;
}

export async function getActiveProject(
  tenantId: number
): Promise<Project | null> {
  const { rows } = await controlQuery<Project>(
    `select id, tenant_id, label, is_active
     from projects where tenant_id = $1 and is_active = true limit 1`,
    [tenantId]
  );
  return rows[0] ?? null;
}

/** Decrypt and return a project's connection string. Used only at query time. */
export async function getProjectConnString(
  projectId: number,
  tenantId: number
): Promise<string | null> {
  const { rows } = await controlQuery<{ conn_enc: string }>(
    `select conn_enc from projects where id = $1 and tenant_id = $2`,
    [projectId, tenantId]
  );
  if (!rows[0]) return null;
  return decrypt(rows[0].conn_enc);
}

export async function logQuery(params: {
  tenantId: number;
  projectId: number | null;
  question: string;
  sql: string | null;
  rowCount: number | null;
  success: boolean;
  error?: string;
}): Promise<void> {
  await controlQuery(
    `insert into queries_log
       (tenant_id, project_id, question, generated_sql, row_count, success, error)
     values ($1,$2,$3,$4,$5,$6,$7)`,
    [
      params.tenantId,
      params.projectId,
      params.question,
      params.sql,
      params.rowCount,
      params.success,
      params.error ?? null,
    ]
  );
}
