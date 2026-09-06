-- Entry points used by the server adapter. They keep bootstrap, order and claim
-- creation behind the same security-definer/RLS boundary as the settlement RPCs.
alter table public.claim_sessions add column if not exists claim_session_expires_at timestamptz;
create table if not exists public.rate_limit_buckets (bucket_key text primary key, window_started timestamptz not null, request_count integer not null);
alter table public.rate_limit_buckets enable row level security;
drop function if exists public.ot_bootstrap(text,uuid);
create function public.ot_bootstrap(p_bootstrap_hash text, p_idempotency_key uuid, p_bootstrap_secret text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare b public.bootstrap_records%rowtype; s uuid;
begin
 if p_bootstrap_secret is null or length(p_bootstrap_secret) < 32 then raise exception 'INVALID_BOOTSTRAP_SECRET'; end if;
 select * into b from public.bootstrap_records where bootstrap_hash=p_bootstrap_hash and idempotency_key=p_idempotency_key for update;
 if found then
   if b.expires_at<=clock_timestamp() then raise exception 'BOOTSTRAP_EXPIRED'; end if;
   if not exists(select 1 from public.demo_scenarios where id=b.scenario_id and expires_at>clock_timestamp()) then raise exception 'SCENARIO_EXPIRED'; end if;
   return jsonb_build_object('scenario_id', b.scenario_id);
 end if;
 insert into public.demo_scenarios(settled_pool_cents,activated,owner_token_hash,expires_at)
 values(2000,true,'pending',now()+interval '24 hours') returning id into s;
 insert into public.merchants(scenario_id,slug,name) values (s,'cafe','Café Sol'),(s,'bakery','Bread & Butter Bakery');
 insert into public.ledger_entries(scenario_id,kind,amount_cents,idempotency_operation,idempotency_key)
 values(s,'historical_contribution_credit',2000,'bootstrap',p_idempotency_key);
 insert into public.bootstrap_records(bootstrap_hash,idempotency_key,request_hash,scenario_id,expires_at) values(p_bootstrap_hash,p_idempotency_key,p_bootstrap_hash,s,now()+interval '10 minutes');
 return jsonb_build_object('scenario_id',s);
end $$;

create or replace function public.ot_set_owner_hash(p_scenario uuid,p_owner_token_hash text)
returns void language sql security definer set search_path=public as $$
 update public.demo_scenarios set owner_token_hash=p_owner_token_hash where id=p_scenario and expires_at>now();
$$;

create or replace function public.ot_create_order(p_scenario uuid,p_merchant text,p_total bigint,p_key uuid,p_hash text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare m uuid; o public.orders%rowtype; replay jsonb;
begin
 select id into m from public.merchants where scenario_id=p_scenario and slug=p_merchant;
 if not found then raise exception 'MERCHANT_NOT_FOUND'; end if;
 replay:=public.ot_idempotency_replay(p_scenario,'create_order',p_key,p_hash); if replay is not null then return replay; end if;
 insert into public.orders(scenario_id,merchant_id,total_cents,customer_tender_cents,remaining_tender_cents,refundable_cents) values(p_scenario,m,p_total,p_total,p_total,p_total) returning * into o;
 return public.ot_idempotency_save(p_scenario,'create_order',p_key,p_hash,to_jsonb(o));
end $$;

create or replace function public.ot_create_claim(p_order uuid,p_claim uuid,p_token_hash text,p_key uuid,p_hash text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare o public.orders%rowtype; s public.demo_scenarios%rowtype; c public.claim_sessions%rowtype; replay jsonb;
begin
 select * into o from public.orders where id=p_order for update; if not found then raise exception 'ORDER_NOT_FOUND'; end if;
 select * into s from public.demo_scenarios where id=o.scenario_id for update; if not found or s.expires_at<=now() then raise exception 'SCENARIO_EXPIRED'; end if;
 replay:=public.ot_idempotency_replay(s.id,'create_claim',p_key,p_hash); if replay is not null then return replay; end if;
 if o.status<>'open' then raise exception 'ORDER_CLOSED'; end if;
 update public.claim_sessions set cancelled_at=now() where order_id=o.id and cancelled_at is null and consumed_at is null;
 insert into public.claim_sessions(id,scenario_id,order_id,token_hash,expires_at) values(p_claim,s.id,o.id,p_token_hash,now()+make_interval(secs=>s.claim_lifetime_seconds)) returning * into c;
 return public.ot_idempotency_save(s.id,'create_claim',p_key,p_hash,jsonb_build_object('claim_id',c.id,'scenario_id',s.id,'expires_at',c.expires_at));
end $$;

create or replace function public.ot_claim_by_token(p_token_hash text)
returns jsonb language sql security definer set search_path=public as $$
 select jsonb_build_object('claim_id',id) from public.claim_sessions where token_hash=p_token_hash limit 1;
$$;

create or replace function public.ot_get_order(p_order uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
declare o public.orders%rowtype; r public.fund_reservations%rowtype;
begin
 select * into o from public.orders where id=p_order; if not found then raise exception 'ORDER_NOT_FOUND'; end if;
 if not exists(select 1 from public.demo_scenarios where id=o.scenario_id and expires_at>clock_timestamp()) then raise exception 'SCENARIO_EXPIRED'; end if;
 if o.status='authorized' then
   select * into r from public.fund_reservations where order_id=o.id and status='authorized' limit 1;
   if found and r.expires_at<=clock_timestamp() then update public.fund_reservations set status='expired' where id=r.id; update public.orders set status='authorization_expired' where id=o.id returning * into o; end if;
 end if;
 return to_jsonb(o);
end $$;

create or replace function public.ot_available_pool(p_scenario uuid)
returns bigint language sql security definer set search_path=public as $$
 select s.settled_pool_cents-coalesce((select sum(amount_cents) from public.fund_reservations r where r.scenario_id=s.id and r.status='authorized' and r.expires_at>clock_timestamp()),0)
 from public.demo_scenarios s where s.id=p_scenario and s.expires_at>clock_timestamp();
$$;

create or replace function public.ot_exchange_claim(p_token_hash text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare c public.claim_sessions%rowtype;
begin
 select * into c from public.claim_sessions where token_hash=p_token_hash for update;
 if not found then raise exception 'CLAIM_NOT_FOUND'; end if;
 if c.cancelled_at is not null or c.expires_at<=now() then raise exception 'CLAIM_EXPIRED'; end if;
 update public.claim_sessions set claim_session_expires_at=coalesce(claim_session_expires_at, clock_timestamp()+interval '10 minutes') where id=c.id returning * into c;
 return jsonb_build_object('claim_id',c.id);
end $$;

create or replace function public.ot_rate_limit(p_key text, p_limit integer, p_window_seconds integer)
returns boolean language plpgsql security definer set search_path=public as $$
declare b public.rate_limit_buckets%rowtype; n timestamptz:=clock_timestamp();
begin
 insert into public.rate_limit_buckets(bucket_key,window_started,request_count) values(p_key,n,1)
 on conflict(bucket_key) do nothing;
 select * into b from public.rate_limit_buckets where bucket_key=p_key for update;
 if b.window_started + make_interval(secs=>p_window_seconds)<=n then update public.rate_limit_buckets set window_started=n,request_count=1 where bucket_key=p_key; return true; end if;
 if b.request_count>=p_limit then return false; end if;
 update public.rate_limit_buckets set request_count=request_count+1 where bucket_key=p_key; return true;
end $$;

-- These helpers are server-only; browsers must never be able to invoke them.
revoke all on all functions in schema public from public, anon, authenticated;
grant execute on all functions in schema public to service_role;
revoke all on table public.rate_limit_buckets from public, anon, authenticated;
grant all on table public.rate_limit_buckets to service_role;
