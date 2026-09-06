#!/usr/bin/env bash
set -euo pipefail

# Requires a running PostgreSQL 16 container named open-tab-pg-smoke with
# POSTGRES_PASSWORD set. This command intentionally recreates only public schema.
container_name="${OPEN_TAB_PG_CONTAINER:-open-tab-pg-smoke}"
password="${POSTGRES_PASSWORD:-opentab_test}"
root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

docker exec -i -e "PGPASSWORD=${password}" "${container_name}" psql -v ON_ERROR_STOP=1 -U postgres -d postgres <<'SQL'
drop schema public cascade;
create schema public;
grant all on schema public to postgres;
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
end $$;
SQL
docker exec -i -e "PGPASSWORD=${password}" "${container_name}" psql -v ON_ERROR_STOP=1 -U postgres -d postgres < "${root_dir}/supabase/migrations/0001_open_tab.sql"
docker exec -i -e "PGPASSWORD=${password}" "${container_name}" psql -v ON_ERROR_STOP=1 -U postgres -d postgres < "${root_dir}/supabase/migrations/0002_integrity_and_rpc.sql"
docker exec -i -e "PGPASSWORD=${password}" "${container_name}" psql -v ON_ERROR_STOP=1 -U postgres -d postgres < "${root_dir}/supabase/migrations/0003_adapter_bootstrap.sql"
docker exec -i -e "PGPASSWORD=${password}" "${container_name}" psql -v ON_ERROR_STOP=1 -U postgres -d postgres < "${root_dir}/supabase/smoke.sql"
