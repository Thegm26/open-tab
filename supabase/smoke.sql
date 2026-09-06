-- Run after 0001 and 0002 against an empty disposable PostgreSQL database.
-- It exercises enum assignments, one-way activation, authorization/completion,
-- idempotency storage, and the core ledger/receivable transition.
do $$ begin
  if not has_function_privilege('service_role', 'public.ot_complete(uuid,uuid,text)', 'EXECUTE') then raise exception 'service_role is missing RPC execute'; end if;
  if has_function_privilege('anon', 'public.ot_complete(uuid,uuid,text)', 'EXECUTE') or has_function_privilege('authenticated', 'public.ot_complete(uuid,uuid,text)', 'EXECUTE') then raise exception 'browser role unexpectedly has RPC execute'; end if;
end $$;

insert into public.demo_scenarios(id, settled_pool_cents, activated, owner_token_hash, expires_at)
values ('11111111-1111-4111-8111-111111111111', 2000, true, 'smoke-owner', clock_timestamp() + interval '1 hour');
insert into public.merchants(id, scenario_id, slug, name)
values ('22222222-2222-4222-8222-222222222222', '11111111-1111-4111-8111-111111111111', 'cafe', 'Smoke Cafe');
insert into public.orders(id, scenario_id, merchant_id, total_cents, customer_tender_cents, remaining_tender_cents, refundable_cents)
values
  ('33333333-3333-4333-8333-333333333333', '11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', 780, 780, 780, 780),
  ('44444444-4444-4444-8444-444444444444', '11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', 450, 450, 450, 450);
select public.ot_roundup('33333333-3333-4333-8333-333333333333', true, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'roundup-smoke');
insert into public.claim_sessions(id, scenario_id, order_id, token_hash, expires_at)
values ('55555555-5555-4555-8555-555555555555', '11111111-1111-4111-8111-111111111111', '44444444-4444-4444-8444-444444444444', 'smoke-claim', clock_timestamp() + interval '5 minutes');
select public.ot_authorize('55555555-5555-4555-8555-555555555555', 'smoke-device', 100, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'authorize-smoke');
select public.ot_complete('44444444-4444-4444-8444-444444444444', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'complete-smoke');
-- Two recovery debts must produce one aggregate recovery ledger event for one settlement idempotency key.
insert into public.merchant_recovery_debts(scenario_id, merchant_id, order_id, amount_cents)
values
  ('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', '44444444-4444-4444-8444-444444444444', 10),
  ('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', '44444444-4444-4444-8444-444444444444', 10);
select public.ot_settle((select id from public.merchant_receivables where order_id='44444444-4444-4444-8444-444444444444'), 'ffffffff-ffff-4fff-8fff-ffffffffffff', 'settle-smoke');
do $$
declare pool bigint; completed public.order_status; receivables integer; recovery_count integer; recovery_sum bigint;
begin
  select settled_pool_cents into pool from public.demo_scenarios where id='11111111-1111-4111-8111-111111111111';
  select status into completed from public.orders where id='44444444-4444-4444-8444-444444444444';
  select count(*) into receivables from public.merchant_receivables where order_id='44444444-4444-4444-8444-444444444444';
  select count(*), coalesce(sum(amount_cents),0) into recovery_count, recovery_sum from public.ledger_entries where kind='merchant_recovery_credit' and idempotency_key='ffffffff-ffff-4fff-8fff-ffffffffffff';
  if pool <> 1940 or completed <> 'completed'::public.order_status or receivables <> 1 or recovery_count <> 1 or recovery_sum <> 20 then raise exception 'smoke assertion failed: pool %, status %, receivables %, recovery count %, recovery sum %', pool, completed, receivables, recovery_count, recovery_sum; end if;
end $$;

-- Adapter helper privileges and explicit round-up decline behavior.
do $$ begin
  if has_function_privilege('anon', 'public.ot_bootstrap(text,uuid,text)', 'EXECUTE') then raise exception 'anon can execute bootstrap'; end if;
  if has_function_privilege('authenticated', 'public.ot_create_order(uuid,text,bigint,uuid,text)', 'EXECUTE') then raise exception 'authenticated can execute create order'; end if;
  if not has_function_privilege('service_role', 'public.ot_available_pool(uuid)', 'EXECUTE') then raise exception 'service role missing adapter execute'; end if;
end $$;
insert into public.orders(id, scenario_id, merchant_id, total_cents, customer_tender_cents, remaining_tender_cents, refundable_cents)
values ('dddddddd-dddd-4ddd-8ddd-dddddddddddd', '11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', 780, 780, 780, 780);
select public.ot_roundup('dddddddd-dddd-4ddd-8ddd-dddddddddddd', true, false, 'abababab-abab-4aba-8aba-abababababab', 'declined-roundup');
do $$ begin
  if (select count(*) from public.ledger_entries where order_id='dddddddd-dddd-4ddd-8ddd-dddddddddddd') <> 0 then raise exception 'declined round-up credited ledger'; end if;
end $$;
select public.ot_bootstrap('bootstrap-smoke', 'abababab-abab-4aba-8aba-abababababac', 'bootstrap-smoke-secret-1234567890123456');
do $$ declare sid uuid; begin
  select scenario_id into sid from public.bootstrap_records where bootstrap_hash='bootstrap-smoke';
  if (select count(*) from public.ledger_entries where scenario_id=sid and kind='historical_contribution_credit') <> 0 then raise exception 'unexpected bootstrap historical credit'; end if;
  perform public.ot_bootstrap('bootstrap-smoke', 'abababab-abab-4aba-8aba-abababababac', 'bootstrap-smoke-secret-1234567890123456');
  if (select count(*) from public.ledger_entries where scenario_id=sid and kind='historical_contribution_credit') <> 0 then raise exception 'unexpected bootstrap replay credit'; end if;
end $$;

do $$ begin
  begin perform public.ot_bootstrap('too-short', 'abababab-abab-4aba-8aba-abababababad', 'short'); exception when others then if sqlerrm = 'INVALID_BOOTSTRAP_SECRET' then return; else raise; end if; end;
  raise exception 'short bootstrap secret accepted';
end $$;
do $$ begin
  begin perform public.ot_bootstrap('missing', 'abababab-abab-4aba-8aba-abababababae', null); exception when others then if sqlerrm = 'INVALID_BOOTSTRAP_SECRET' then return; else raise; end if; end;
  raise exception 'missing bootstrap secret accepted';
end $$;

-- The same client key is valid in different operation namespaces, even when both emit a debit.
insert into public.orders(id, scenario_id, merchant_id, total_cents, customer_tender_cents, remaining_tender_cents, refundable_cents)
values
  ('88888888-8888-4888-8888-888888888888', '11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', 100, 100, 100, 100),
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', 200, 200, 200, 200);
insert into public.claim_sessions(id, scenario_id, order_id, token_hash, expires_at)
values
  ('99999999-9999-4999-8999-999999999999', '11111111-1111-4111-8111-111111111111', '88888888-8888-4888-8888-888888888888', 'full-key-claim', clock_timestamp() + interval '5 minutes'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '11111111-1111-4111-8111-111111111111', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'partial-key-claim', clock_timestamp() + interval '5 minutes');
select public.ot_authorize('99999999-9999-4999-8999-999999999999', 'full-key-device', 100, '12121212-1212-4212-8212-121212121212', 'full-authorize');
select public.ot_authorize('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'partial-key-device', 100, '13131313-1313-4313-8313-131313131313', 'partial-authorize');
select public.ot_complete('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '12121212-1212-4212-8212-121212121212', 'partial-complete-same-key');
do $$ begin
  if (select count(*) from public.ledger_entries where kind='redemption_debit' and idempotency_key='12121212-1212-4212-8212-121212121212') <> 2 then raise exception 'operation-namespaced ledger idempotency failed'; end if;
end $$;

-- `now()` is transaction-start time; this proves expiry uses clock_timestamp() after locks.
update public.demo_scenarios set authorization_lifetime_seconds=1 where id='11111111-1111-4111-8111-111111111111';
insert into public.orders(id, scenario_id, merchant_id, total_cents, customer_tender_cents, remaining_tender_cents, refundable_cents)
values ('66666666-6666-4666-8666-666666666666', '11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', 200, 200, 200, 200);
insert into public.claim_sessions(id, scenario_id, order_id, token_hash, expires_at)
values ('77777777-7777-4777-8777-777777777777', '11111111-1111-4111-8111-111111111111', '66666666-6666-4666-8666-666666666666', 'expiry-claim', clock_timestamp() + interval '5 minutes');
select public.ot_authorize('77777777-7777-4777-8777-777777777777', 'expiry-device', 100, 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'expiry-authorize');
do $$
declare completion jsonb; order_status public.order_status; reservation_status public.reservation_status;
begin
  perform pg_sleep(1.2);
  select public.ot_complete('66666666-6666-4666-8666-666666666666', 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'expiry-complete') into completion;
  if completion->>'status' <> 'AUTHORIZATION_EXPIRED' then raise exception 'expired completion unexpectedly succeeded: %', completion; end if;
  -- Same idempotency key returns the committed terminal response.
  if public.ot_complete('66666666-6666-4666-8666-666666666666', 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'expiry-complete') <> completion then raise exception 'expired completion replay differs'; end if;
  select status into order_status from public.orders where id='66666666-6666-4666-8666-666666666666';
  select status into reservation_status from public.fund_reservations where order_id='66666666-6666-4666-8666-666666666666';
  if order_status <> 'authorization_expired'::public.order_status or reservation_status <> 'expired'::public.reservation_status then raise exception 'expired terminal state was not persisted'; end if;
end $$;

-- Claim exchange replay keeps the original fixed browser-session expiry.
insert into public.claim_sessions(id, scenario_id, order_id, token_hash, expires_at)
values ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', '11111111-1111-4111-8111-111111111111', 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'exchange-smoke', clock_timestamp() + interval '5 minutes');
select public.ot_exchange_claim('exchange-smoke');
do $$ declare first_exp timestamptz; second_exp timestamptz; begin
  select claim_session_expires_at into first_exp from public.claim_sessions where id='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  perform pg_sleep(1.1); perform public.ot_exchange_claim('exchange-smoke');
  select claim_session_expires_at into second_exp from public.claim_sessions where id='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  if second_exp is distinct from first_exp then raise exception 'claim exchange replay extended expiry'; end if;
end $$;
