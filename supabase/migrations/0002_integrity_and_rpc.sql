-- Cross-scenario integrity and server-only transaction RPCs. Apply after 0001.
-- Every function takes a caller-provided request hash plus UUID idempotency key; an
-- exact replay returns the original JSON and a changed payload fails closed.

alter table public.merchants add constraint merchants_scenario_id_id_unique unique (scenario_id, id);
alter table public.orders add constraint orders_scenario_id_id_unique unique (scenario_id, id);
alter table public.claim_sessions add constraint claims_scenario_id_id_unique unique (scenario_id, id);
alter table public.fund_reservations add constraint reservations_scenario_id_id_unique unique (scenario_id, id);
alter table public.merchant_receivables add constraint receivables_scenario_id_id_unique unique (scenario_id, id);
alter table public.merchant_recovery_debts add constraint debts_scenario_id_id_unique unique (scenario_id, id);
alter table public.refund_events add constraint refunds_scenario_id_id_unique unique (scenario_id, id);
alter table public.ledger_entries add constraint ledger_scenario_id_id_unique unique (scenario_id, id);

alter table public.orders add constraint orders_scenario_merchant_fk foreign key (scenario_id, merchant_id) references public.merchants(scenario_id, id);
alter table public.claim_sessions add constraint claims_scenario_order_fk foreign key (scenario_id, order_id) references public.orders(scenario_id, id);
alter table public.fund_reservations add constraint reservations_scenario_claim_fk foreign key (scenario_id, claim_id) references public.claim_sessions(scenario_id, id);
alter table public.fund_reservations add constraint reservations_scenario_order_fk foreign key (scenario_id, order_id) references public.orders(scenario_id, id);
alter table public.merchant_receivables add constraint receivables_scenario_order_fk foreign key (scenario_id, order_id) references public.orders(scenario_id, id);
alter table public.merchant_receivables add constraint receivables_scenario_merchant_fk foreign key (scenario_id, merchant_id) references public.merchants(scenario_id, id);
alter table public.merchant_recovery_debts add constraint debts_scenario_order_fk foreign key (scenario_id, order_id) references public.orders(scenario_id, id);
alter table public.merchant_recovery_debts add constraint debts_scenario_merchant_fk foreign key (scenario_id, merchant_id) references public.merchants(scenario_id, id);
alter table public.refund_events add constraint refunds_scenario_order_fk foreign key (scenario_id, order_id) references public.orders(scenario_id, id);
alter table public.ledger_entries add constraint ledger_scenario_order_fk foreign key (scenario_id, order_id) references public.orders(scenario_id, id);
alter table public.ledger_entries add constraint ledger_scenario_merchant_fk foreign key (scenario_id, merchant_id) references public.merchants(scenario_id, id);
alter table public.device_redemptions add constraint device_scenario_order_fk foreign key (scenario_id, order_id) references public.orders(scenario_id, id);
alter table public.settlements add constraint settlements_scenario_receivable_fk foreign key (scenario_id, receivable_id) references public.merchant_receivables(scenario_id, id);
alter table public.settlements add constraint settlements_scenario_merchant_fk foreign key (scenario_id, merchant_id) references public.merchants(scenario_id, id);

create or replace function public.ot_guard_activation()
returns trigger language plpgsql set search_path = public as $$
begin
  if tg_op = 'UPDATE' and old.activated then new.activated := true;
  elsif new.settled_pool_cents >= new.activation_threshold_cents then new.activated := true;
  end if;
  return new;
end $$;
create trigger demo_scenarios_one_way_activation before insert or update of settled_pool_cents, activation_threshold_cents, activated on public.demo_scenarios
for each row execute function public.ot_guard_activation();

create or replace function public.ot_idempotency_replay(p_scenario uuid, p_operation text, p_key uuid, p_hash text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare saved public.idempotency_records%rowtype;
begin
  select * into saved from public.idempotency_records where scenario_id=p_scenario and operation=p_operation and idempotency_key=p_key for update;
  if found then
    if saved.request_hash <> p_hash then raise exception 'IDEMPOTENCY_CONFLICT' using errcode='P0001'; end if;
    return saved.response_body;
  end if;
  return null;
end $$;
create or replace function public.ot_idempotency_save(p_scenario uuid, p_operation text, p_key uuid, p_hash text, p_body jsonb)
returns jsonb language sql security definer set search_path = public as $$
  insert into public.idempotency_records(scenario_id,operation,idempotency_key,request_hash,response_status,response_body)
  values (p_scenario,p_operation,p_key,p_hash,200,p_body) returning response_body
$$;

drop function if exists public.ot_roundup(uuid,boolean,uuid,text);
create or replace function public.ot_roundup(p_order uuid, p_succeeded boolean, p_accept_roundup boolean, p_key uuid, p_hash text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare o public.orders%rowtype; s public.demo_scenarios%rowtype; v_credit bigint; v_now timestamptz; out jsonb;
begin
 select scenario_id into o.scenario_id from public.orders where id=p_order; if not found then raise exception 'ORDER_NOT_FOUND'; end if;
 select * into s from public.demo_scenarios where id=o.scenario_id for update; if not found then raise exception 'SCENARIO_EXPIRED'; end if;
 select * into o from public.orders where id=p_order and scenario_id=s.id for update;
 v_now:=clock_timestamp(); if s.expires_at<=v_now then raise exception 'SCENARIO_EXPIRED'; end if;
 out:=public.ot_idempotency_replay(s.id,'roundup',p_key,p_hash); if out is not null then return out; end if;
 if o.status<>'open' then raise exception 'ORDER_CLOSED'; end if;
 if not p_succeeded then update public.orders set status='payment_failed' where id=o.id; out:=jsonb_build_object('status','DECLINED','contributionCents',0); return public.ot_idempotency_save(s.id,'roundup',p_key,p_hash,out); end if;
 v_credit := case when p_accept_roundup then (50 - (o.total_cents % 50)) % 50 else 0 end;
 update public.orders set status='completed',remaining_tender_cents=0 where id=o.id;
 if v_credit>0 then
   update public.demo_scenarios set settled_pool_cents=settled_pool_cents+v_credit, activated=activated or settled_pool_cents+v_credit>=activation_threshold_cents where id=s.id;
   insert into public.ledger_entries(scenario_id,order_id,merchant_id,kind,amount_cents,idempotency_operation,idempotency_key) values(s.id,o.id,o.merchant_id,'roundup_credit',v_credit,'roundup',p_key);
 end if;
 out:=jsonb_build_object('status','COMPLETED','contributionCents',v_credit); return public.ot_idempotency_save(s.id,'roundup',p_key,p_hash,out);
end $$;

create or replace function public.ot_roundup(p_order uuid, p_succeeded boolean, p_key uuid, p_hash text)
returns jsonb language sql security definer set search_path = public as $$
  select public.ot_roundup(p_order,p_succeeded,true,p_key,p_hash)
$$;

create or replace function public.ot_authorize(p_claim uuid, p_device_hash text, p_amount bigint, p_key uuid, p_hash text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare c public.claim_sessions%rowtype; o public.orders%rowtype; s public.demo_scenarios%rowtype; r uuid:=gen_random_uuid(); v_available bigint; v_device bigint; out jsonb; v_exp timestamptz; v_now timestamptz;
begin
 select scenario_id into c.scenario_id from public.claim_sessions where id=p_claim; if not found then raise exception 'CLAIM_NOT_FOUND'; end if;
 select * into s from public.demo_scenarios where id=c.scenario_id for update; if not found then raise exception 'SCENARIO_EXPIRED'; end if;
 select * into c from public.claim_sessions where id=p_claim and scenario_id=s.id for update;
 select * into o from public.orders where id=c.order_id and scenario_id=s.id for update;
 v_now:=clock_timestamp(); if s.expires_at<=v_now then raise exception 'SCENARIO_EXPIRED'; end if;
 out:=public.ot_idempotency_replay(s.id,'authorize',p_key,p_hash); if out is not null then return out; end if;
 if c.cancelled_at is not null or c.expires_at<=v_now then raise exception 'CLAIM_EXPIRED'; end if;
 if c.consumed_at is not null or o.status<>'open' then raise exception 'CLAIM_USED'; end if;
 if p_amount<=0 or p_amount>o.remaining_tender_cents or p_amount>s.per_order_limit_cents then raise exception 'INVALID_ASSISTANCE_AMOUNT'; end if;
 if not s.activated then raise exception 'POOL_INACTIVE'; end if;
 select s.settled_pool_cents-coalesce(sum(amount_cents) filter(where status='authorized' and expires_at>v_now),0) into v_available from public.fund_reservations where scenario_id=s.id;
 if p_amount>v_available then raise exception 'INSUFFICIENT_POOL'; end if;
 select coalesce(sum(gross_cents-pool_reversed_cents) filter(where completed_at>=v_now-interval '24 hours'),0)+coalesce((select sum(amount_cents) from public.fund_reservations where scenario_id=s.id and device_hash=p_device_hash and status='authorized' and expires_at>v_now),0) into v_device from public.device_redemptions where scenario_id=s.id and device_hash=p_device_hash;
 if v_device+p_amount>s.device_daily_limit_cents then raise exception 'LIMIT_EXCEEDED'; end if;
 v_exp:=v_now+make_interval(secs=>s.authorization_lifetime_seconds);
 update public.claim_sessions set consumed_at=v_now where id=c.id;
 update public.orders set open_tab_cents=p_amount,customer_tender_cents=total_cents-p_amount,remaining_tender_cents=total_cents-p_amount,status=case when total_cents=p_amount then 'completed'::public.order_status else 'authorized'::public.order_status end where id=o.id;
 insert into public.fund_reservations(id,scenario_id,claim_id,order_id,device_hash,amount_cents,expires_at,status) values(r,s.id,c.id,o.id,p_device_hash,p_amount,v_exp,case when p_amount=o.total_cents then 'completed'::public.reservation_status else 'authorized'::public.reservation_status end);
 if p_amount=o.total_cents then
   update public.demo_scenarios set settled_pool_cents=settled_pool_cents-p_amount where id=s.id;
   insert into public.ledger_entries(scenario_id,order_id,merchant_id,kind,amount_cents,idempotency_operation,idempotency_key) values(s.id,o.id,o.merchant_id,'redemption_debit',-p_amount,'authorize',p_key);
   insert into public.merchant_receivables(scenario_id,order_id,merchant_id,original_cents) values(s.id,o.id,o.merchant_id,p_amount);
   insert into public.device_redemptions(scenario_id,order_id,device_hash,gross_cents) values(s.id,o.id,p_device_hash,p_amount);
   out:=jsonb_build_object('status','COMPLETED','reservationId',r,'amountCents',p_amount,'remainingTenderCents',0);
 else out:=jsonb_build_object('status','AUTHORIZED','reservationId',r,'amountCents',p_amount,'remainingTenderCents',o.total_cents-p_amount,'expiresAt',v_exp); end if;
 return public.ot_idempotency_save(s.id,'authorize',p_key,p_hash,out);
end $$;

create or replace function public.ot_complete(p_order uuid, p_key uuid, p_hash text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare o public.orders%rowtype; s public.demo_scenarios%rowtype; r public.fund_reservations%rowtype; v_now timestamptz; out jsonb;
begin
 select scenario_id into o.scenario_id from public.orders where id=p_order; if not found then raise exception 'ORDER_NOT_FOUND'; end if;
 select * into s from public.demo_scenarios where id=o.scenario_id for update; if not found then raise exception 'SCENARIO_EXPIRED'; end if;
 select * into o from public.orders where id=p_order and scenario_id=s.id for update;
 out:=public.ot_idempotency_replay(s.id,'complete',p_key,p_hash); if out is not null then return out; end if;
 select * into r from public.fund_reservations where order_id=o.id for update;
 v_now:=clock_timestamp(); if s.expires_at<=v_now then raise exception 'SCENARIO_EXPIRED'; end if;
 if o.status<>'authorized' or not found then raise exception 'ORDER_CLOSED'; end if;
 if r.expires_at<=v_now then
   update public.fund_reservations set status='expired'::public.reservation_status where id=r.id;
   update public.orders set status='authorization_expired'::public.order_status where id=o.id;
   out:=jsonb_build_object('status','AUTHORIZATION_EXPIRED','error','AUTHORIZATION_EXPIRED');
   return public.ot_idempotency_save(s.id,'complete',p_key,p_hash,out);
 end if;
 update public.fund_reservations set status='completed' where id=r.id;
 update public.orders set status='completed',remaining_tender_cents=0 where id=o.id;
 update public.demo_scenarios set settled_pool_cents=settled_pool_cents-r.amount_cents where id=s.id;
 insert into public.ledger_entries(scenario_id,order_id,merchant_id,kind,amount_cents,idempotency_operation,idempotency_key) values(s.id,o.id,o.merchant_id,'redemption_debit',-r.amount_cents,'complete',p_key);
 insert into public.merchant_receivables(scenario_id,order_id,merchant_id,original_cents) values(s.id,o.id,o.merchant_id,r.amount_cents);
 insert into public.device_redemptions(scenario_id,order_id,device_hash,gross_cents) values(s.id,o.id,r.device_hash,r.amount_cents);
 out:=jsonb_build_object('status','COMPLETED','openTabCents',r.amount_cents); return public.ot_idempotency_save(s.id,'complete',p_key,p_hash,out);
end $$;

create or replace function public.ot_close(p_order uuid, p_reason text, p_key uuid, p_hash text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare o public.orders%rowtype; s public.demo_scenarios%rowtype; v_now timestamptz; out jsonb;
begin
 select scenario_id into o.scenario_id from public.orders where id=p_order; if not found then raise exception 'ORDER_NOT_FOUND'; end if;
 select * into s from public.demo_scenarios where id=o.scenario_id for update;
 if not found then raise exception 'SCENARIO_EXPIRED'; end if;
 select * into o from public.orders where id=p_order and scenario_id=s.id for update;
 v_now:=clock_timestamp(); if s.expires_at<=v_now then raise exception 'SCENARIO_EXPIRED'; end if;
 out:=public.ot_idempotency_replay(s.id,'close_'||p_reason,p_key,p_hash); if out is not null then return out; end if;
 if o.status in ('completed','partially_refunded','refunded') then raise exception 'ORDER_COMPLETED_USE_REFUND'; end if;
 if o.status not in ('open','authorized') then raise exception 'ORDER_CLOSED'; end if;
 if o.status='authorized' then update public.fund_reservations set status='cancelled' where order_id=o.id and status='authorized'; end if;
 update public.claim_sessions set cancelled_at=v_now where order_id=o.id and cancelled_at is null;
 update public.orders set status=case when p_reason='failed' then 'payment_failed'::public.order_status else 'cancelled'::public.order_status end where id=o.id;
 out:=jsonb_build_object('status',case when p_reason='failed' then 'payment_failed' else 'cancelled' end); return public.ot_idempotency_save(s.id,'close_'||p_reason,p_key,p_hash,out);
end $$;

create or replace function public.ot_refund(p_order uuid, p_requested bigint, p_external_id text, p_key uuid, p_hash text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare o public.orders%rowtype; s public.demo_scenarios%rowtype; rec public.merchant_receivables%rowtype; v_total bigint; v_customer bigint; v_pool bigint; v_customer_delta bigint; v_pool_delta bigint; v_debt bigint:=0; v_now timestamptz; out jsonb;
begin
 select scenario_id into o.scenario_id from public.orders where id=p_order; if not found then raise exception 'ORDER_NOT_FOUND'; end if;
 select * into s from public.demo_scenarios where id=o.scenario_id for update; if not found then raise exception 'SCENARIO_EXPIRED'; end if;
 select * into o from public.orders where id=p_order and scenario_id=s.id for update;
 v_now:=clock_timestamp(); if s.expires_at<=v_now then raise exception 'SCENARIO_EXPIRED'; end if;
 out:=public.ot_idempotency_replay(s.id,'refund',p_key,p_hash); if out is not null then return out; end if;
 if o.status not in ('completed','partially_refunded') or p_requested<=0 then raise exception 'ORDER_NOT_REFUNDABLE'; end if;
 if exists(select 1 from public.refund_events where order_id=o.id and external_id=p_external_id) then raise exception 'DUPLICATE_REFUND_EVENT'; end if;
 v_total:=o.refunded_cents+p_requested; if v_total>o.refundable_cents then raise exception 'REFUND_EXCEEDS_ORDER'; end if;
 v_customer:=least(v_total,o.customer_tender_cents); v_pool:=least(o.open_tab_cents,greatest(0,v_total-o.customer_tender_cents));
 v_customer_delta:=v_customer-o.customer_refunded_cents; v_pool_delta:=v_pool-o.pool_refunded_cents;
 update public.orders set refunded_cents=v_total,customer_refunded_cents=v_customer,pool_refunded_cents=v_pool,status=case when v_total=refundable_cents then 'refunded'::public.order_status else 'partially_refunded'::public.order_status end where id=o.id;
 insert into public.refund_events(scenario_id,order_id,external_id,requested_cents,cumulative_order_refund_cents,customer_delta_cents,pool_delta_cents,idempotency_key) values(s.id,o.id,p_external_id,p_requested,v_total,v_customer_delta,v_pool_delta,p_key);
 if v_pool_delta>0 then
   update public.device_redemptions set pool_reversed_cents=pool_reversed_cents+v_pool_delta where order_id=o.id;
   select * into rec from public.merchant_receivables where order_id=o.id for update;
   if rec.status='unsettled' then
     update public.merchant_receivables set reduced_cents=reduced_cents+v_pool_delta,status=case when reduced_cents+v_pool_delta=original_cents then 'fully_reversed'::public.receivable_status else 'unsettled'::public.receivable_status end where id=rec.id;
     update public.demo_scenarios set settled_pool_cents=settled_pool_cents+v_pool_delta where id=s.id;
     insert into public.ledger_entries(scenario_id,order_id,merchant_id,kind,amount_cents,idempotency_operation,idempotency_key) values(s.id,o.id,o.merchant_id,'redemption_reversal_credit',v_pool_delta,'refund',p_key);
   else
     insert into public.merchant_recovery_debts(scenario_id,merchant_id,order_id,amount_cents) values(s.id,o.merchant_id,o.id,v_pool_delta); v_debt:=v_pool_delta;
   end if;
 end if;
 out:=jsonb_build_object('customerDeltaCents',v_customer_delta,'poolDeltaCents',v_pool_delta,'merchantDebtCents',v_debt,'cumulativeRefundedCents',v_total); return public.ot_idempotency_save(s.id,'refund',p_key,p_hash,out);
end $$;

create or replace function public.ot_settle(p_receivable uuid, p_key uuid, p_hash text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare rec public.merchant_receivables%rowtype; s public.demo_scenarios%rowtype; d public.merchant_recovery_debts%rowtype; v_residual bigint; v_payout bigint; v_step bigint; v_recovered bigint:=0; v_now timestamptz; out jsonb;
begin
 select scenario_id into rec.scenario_id from public.merchant_receivables where id=p_receivable; if not found then raise exception 'RECEIVABLE_NOT_FOUND'; end if;
 select * into s from public.demo_scenarios where id=rec.scenario_id for update; if not found then raise exception 'SCENARIO_EXPIRED'; end if;
 select * into rec from public.merchant_receivables where id=p_receivable and scenario_id=s.id for update;
 v_now:=clock_timestamp(); if s.expires_at<=v_now then raise exception 'SCENARIO_EXPIRED'; end if;
 out:=public.ot_idempotency_replay(s.id,'settle',p_key,p_hash); if out is not null then return out; end if;
 v_residual:=rec.original_cents-rec.reduced_cents-rec.settled_cents; if rec.status<>'unsettled' or v_residual<=0 then raise exception 'RECEIVABLE_NOT_SETTLEABLE'; end if;
 for d in select * from public.merchant_recovery_debts where scenario_id=s.id and merchant_id=rec.merchant_id and recovered_cents<amount_cents order by created_at for update loop
   exit when v_residual=0; v_step:=least(v_residual,d.amount_cents-d.recovered_cents); update public.merchant_recovery_debts set recovered_cents=recovered_cents+v_step where id=d.id;
   v_recovered:=v_recovered+v_step; v_residual:=v_residual-v_step;
 end loop;
 if v_recovered>0 then
   update public.demo_scenarios set settled_pool_cents=settled_pool_cents+v_recovered where id=s.id;
   insert into public.ledger_entries(scenario_id,order_id,merchant_id,kind,amount_cents,idempotency_operation,idempotency_key) values(s.id,rec.order_id,rec.merchant_id,'merchant_recovery_credit',v_recovered,'settle',p_key);
 end if;
 v_payout:=v_residual;
 update public.merchant_receivables set settled_cents=original_cents-reduced_cents,status='settled' where id=rec.id;
 insert into public.settlements(scenario_id,merchant_id,receivable_id,amount_cents,recovered_cents,idempotency_key) values(s.id,rec.merchant_id,rec.id,v_payout,v_recovered,p_key);
 out:=jsonb_build_object('merchantPayoutCents',v_payout,'recoveredCents',v_recovered); return public.ot_idempotency_save(s.id,'settle',p_key,p_hash,out);
end $$;

create or replace function public.ot_repay_debt(p_debt uuid, p_amount bigint, p_key uuid, p_hash text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare d public.merchant_recovery_debts%rowtype; s public.demo_scenarios%rowtype; v_now timestamptz; out jsonb;
begin
 select scenario_id into d.scenario_id from public.merchant_recovery_debts where id=p_debt; if not found then raise exception 'DEBT_NOT_FOUND'; end if;
 select * into s from public.demo_scenarios where id=d.scenario_id for update; if not found then raise exception 'SCENARIO_EXPIRED'; end if;
 select * into d from public.merchant_recovery_debts where id=p_debt and scenario_id=s.id for update;
 v_now:=clock_timestamp(); if s.expires_at<=v_now then raise exception 'SCENARIO_EXPIRED'; end if;
 out:=public.ot_idempotency_replay(s.id,'repay_debt',p_key,p_hash); if out is not null then return out; end if;
 if p_amount<=0 or p_amount>d.amount_cents-d.recovered_cents then raise exception 'INVALID_RECOVERY_AMOUNT'; end if;
 update public.merchant_recovery_debts set recovered_cents=recovered_cents+p_amount where id=d.id; update public.demo_scenarios set settled_pool_cents=settled_pool_cents+p_amount where id=s.id;
 insert into public.ledger_entries(scenario_id,order_id,merchant_id,kind,amount_cents,idempotency_operation,idempotency_key) values(s.id,d.order_id,d.merchant_id,'merchant_recovery_credit',p_amount,'repay_debt',p_key);
 out:=jsonb_build_object('recoveredCents',p_amount); return public.ot_idempotency_save(s.id,'repay_debt',p_key,p_hash,out);
end $$;

revoke all on all functions in schema public from public;
revoke all on all functions in schema public from anon;
revoke all on all functions in schema public from authenticated;
grant execute on all functions in schema public to service_role;
do $$ begin
end $$;
