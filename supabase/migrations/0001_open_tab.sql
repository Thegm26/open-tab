-- Open Tab simulated-money MVP. All application writes must run through server-side
-- RPC functions/transactions; anon/authenticated clients are intentionally denied.
create extension if not exists pgcrypto;

create type public.order_status as enum ('open','authorized','authorization_expired','completed','payment_failed','cancelled','partially_refunded','refunded');
create type public.reservation_status as enum ('authorized','completed','expired','cancelled');
create type public.receivable_status as enum ('unsettled','settled','fully_reversed');
create type public.ledger_kind as enum ('historical_contribution_credit','roundup_credit','redemption_debit','redemption_reversal_credit','merchant_recovery_credit');

create table public.demo_scenarios (
  id uuid primary key default gen_random_uuid(),
  currency text not null default 'EUR' check (currency = 'EUR'),
  settled_pool_cents bigint not null default 0 check (settled_pool_cents >= 0),
  activated boolean not null default false,
  activation_threshold_cents bigint not null default 2000 check (activation_threshold_cents >= 0),
  per_order_limit_cents bigint not null default 500 check (per_order_limit_cents > 0),
  device_daily_limit_cents bigint not null default 1000 check (device_daily_limit_cents > 0),
  claim_lifetime_seconds integer not null default 300 check (claim_lifetime_seconds > 0),
  authorization_lifetime_seconds integer not null default 120 check (authorization_lifetime_seconds > 0),
  owner_token_hash text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create table public.merchants (
  id uuid primary key default gen_random_uuid(), scenario_id uuid not null references public.demo_scenarios(id) on delete cascade,
  slug text not null, name text not null, unique (scenario_id, slug)
);
create table public.orders (
  id uuid primary key default gen_random_uuid(), scenario_id uuid not null references public.demo_scenarios(id) on delete cascade,
  merchant_id uuid not null references public.merchants(id), total_cents bigint not null check (total_cents > 0),
  open_tab_cents bigint not null default 0 check (open_tab_cents >= 0), customer_tender_cents bigint not null check (customer_tender_cents >= 0),
  remaining_tender_cents bigint not null check (remaining_tender_cents >= 0),
  status public.order_status not null default 'open', refundable_cents bigint not null, refunded_cents bigint not null default 0,
  customer_refunded_cents bigint not null default 0, pool_refunded_cents bigint not null default 0, created_at timestamptz not null default now(),
  check (open_tab_cents + customer_tender_cents = total_cents), check (remaining_tender_cents <= customer_tender_cents), check (refunded_cents <= refundable_cents)
);
create table public.processor_events (
  id uuid primary key default gen_random_uuid(), order_id uuid not null references public.orders(id), external_id text not null,
  amount_cents bigint not null check (amount_cents >= 0), status text not null check (status in ('succeeded','declined','failed','refunded')),
  created_at timestamptz not null default now(), unique(order_id, external_id)
);
create table public.claim_sessions (
  id uuid primary key default gen_random_uuid(), scenario_id uuid not null references public.demo_scenarios(id) on delete cascade,
  order_id uuid not null references public.orders(id), token_hash text not null unique, generation integer not null default 1,
  expires_at timestamptz not null, consumed_at timestamptz, cancelled_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index claim_one_active_order on public.claim_sessions(order_id) where cancelled_at is null and consumed_at is null;
create table public.fund_reservations (
  id uuid primary key default gen_random_uuid(), scenario_id uuid not null references public.demo_scenarios(id) on delete cascade,
  claim_id uuid not null unique references public.claim_sessions(id), order_id uuid not null unique references public.orders(id),
  device_hash text not null, amount_cents bigint not null check (amount_cents > 0), status public.reservation_status not null default 'authorized',
  expires_at timestamptz not null, created_at timestamptz not null default now()
);
create index reservation_active_lookup on public.fund_reservations(scenario_id, device_hash, expires_at) where status = 'authorized';
create table public.ledger_entries (
  id uuid primary key default gen_random_uuid(), scenario_id uuid not null references public.demo_scenarios(id) on delete cascade,
  order_id uuid references public.orders(id), merchant_id uuid references public.merchants(id), kind public.ledger_kind not null,
  amount_cents bigint not null check (amount_cents <> 0), original_entry_id uuid references public.ledger_entries(id),
  idempotency_operation text not null, idempotency_key uuid not null, metadata jsonb not null default '{}'::jsonb, created_at timestamptz not null default now(),
  unique (scenario_id, idempotency_operation, kind, idempotency_key)
);
create table public.merchant_receivables (
  id uuid primary key default gen_random_uuid(), scenario_id uuid not null references public.demo_scenarios(id) on delete cascade,
  order_id uuid not null unique references public.orders(id), merchant_id uuid not null references public.merchants(id),
  original_cents bigint not null check (original_cents > 0), reduced_cents bigint not null default 0 check (reduced_cents >= 0),
  settled_cents bigint not null default 0 check (settled_cents >= 0), status public.receivable_status not null default 'unsettled', created_at timestamptz not null default now(),
  check (reduced_cents + settled_cents <= original_cents)
);
create table public.merchant_recovery_debts (
  id uuid primary key default gen_random_uuid(), scenario_id uuid not null references public.demo_scenarios(id) on delete cascade,
  merchant_id uuid not null references public.merchants(id), order_id uuid not null references public.orders(id),
  amount_cents bigint not null check (amount_cents > 0), recovered_cents bigint not null default 0 check (recovered_cents >= 0 and recovered_cents <= amount_cents),
  created_at timestamptz not null default now()
);
create table public.refund_events (
  id uuid primary key default gen_random_uuid(), scenario_id uuid not null references public.demo_scenarios(id) on delete cascade,
  order_id uuid not null references public.orders(id), external_id text not null, requested_cents bigint not null check (requested_cents > 0),
  cumulative_order_refund_cents bigint not null, customer_delta_cents bigint not null default 0, pool_delta_cents bigint not null default 0,
  idempotency_key uuid not null, created_at timestamptz not null default now(), unique(order_id, external_id), unique(scenario_id, idempotency_key)
);
create table public.device_redemptions (
  id uuid primary key default gen_random_uuid(), scenario_id uuid not null references public.demo_scenarios(id) on delete cascade,
  order_id uuid not null unique references public.orders(id), device_hash text not null, gross_cents bigint not null check (gross_cents > 0),
  pool_reversed_cents bigint not null default 0 check (pool_reversed_cents >= 0 and pool_reversed_cents <= gross_cents), completed_at timestamptz not null default now()
);
create table public.settlements (
  id uuid primary key default gen_random_uuid(), scenario_id uuid not null references public.demo_scenarios(id) on delete cascade,
  merchant_id uuid not null references public.merchants(id), receivable_id uuid not null unique references public.merchant_receivables(id),
  amount_cents bigint not null check (amount_cents >= 0), recovered_cents bigint not null default 0 check (recovered_cents >= 0), idempotency_key uuid not null,
  created_at timestamptz not null default now(), unique(scenario_id, idempotency_key)
);
create table public.idempotency_records (
  scenario_id uuid not null references public.demo_scenarios(id) on delete cascade, operation text not null, idempotency_key uuid not null,
  request_hash text not null, response_status integer not null, response_body jsonb not null, completed_at timestamptz not null default now(),
  primary key (scenario_id, operation, idempotency_key)
);
create table public.bootstrap_records (
  bootstrap_hash text not null, idempotency_key uuid not null, request_hash text not null, scenario_id uuid not null references public.demo_scenarios(id) on delete cascade,
  expires_at timestamptz not null, primary key (bootstrap_hash, idempotency_key)
);

-- RLS is defense in depth. The app's server uses a service role; browsers have no table access.
alter table public.demo_scenarios enable row level security;
alter table public.merchants enable row level security;
alter table public.orders enable row level security;
alter table public.processor_events enable row level security;
alter table public.claim_sessions enable row level security;
alter table public.fund_reservations enable row level security;
alter table public.ledger_entries enable row level security;
alter table public.merchant_receivables enable row level security;
alter table public.merchant_recovery_debts enable row level security;
alter table public.refund_events enable row level security;
alter table public.device_redemptions enable row level security;
alter table public.settlements enable row level security;
alter table public.idempotency_records enable row level security;
alter table public.bootstrap_records enable row level security;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then revoke all on all tables in schema public from anon; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then revoke all on all tables in schema public from authenticated; end if;
end $$;

-- Production RPCs must lock the scenario then applicable order/reservation rows with
-- SELECT ... FOR UPDATE and use now() inside one transaction. This prevents stale
-- reservations, overdraws, duplicate business events, and completion/expiry races.
