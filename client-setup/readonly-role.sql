-- Client setup. Run this once in the client's Supabase SQL Editor.
-- It creates a read-only database user for the analytics bot.

-- 1. Pick a strong password and replace CHANGE_ME_STRONG_PASSWORD below.
create role readonly_bot with login password 'CHANGE_ME_STRONG_PASSWORD';

-- 2. Allow it to connect and read the public schema. Add more schemas if needed.
grant connect on database postgres to readonly_bot;
grant usage on schema public to readonly_bot;
grant select on all tables in schema public to readonly_bot;

-- 3. Make future tables readable too.
alter default privileges in schema public
  grant select on tables to readonly_bot;

-- 4. Hard-enforce read-only at the role level.
alter role readonly_bot set default_transaction_read_only = on;

-- Give the bot this connection string, using the password you set above:
--
-- postgresql://readonly_bot:CHANGE_ME_STRONG_PASSWORD@HOST:5432/postgres
