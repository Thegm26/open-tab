-- Round-ups are a product rule, not merchant configuration. Keep the legacy
-- column for applied-migration compatibility, but never read it.
drop function if exists public.ot_create_order(uuid,text,bigint,bigint,uuid,text);
create function public.ot_create_order(
  p_scenario uuid, p_merchant text, p_total bigint, p_key uuid, p_hash text
)
returns jsonb language plpgsql security definer set search_path = public as $$
declare m uuid; o public.orders%rowtype; replay jsonb;
begin
 if p_total is null or p_total <= 0 then raise exception 'INVALID_AMOUNT'; end if;
 select id into m from public.merchants where scenario_id=p_scenario and slug=p_merchant;
 if not found then raise exception 'MERCHANT_NOT_FOUND'; end if;
 replay:=public.ot_idempotency_replay(p_scenario,'create_order',p_key,p_hash); if replay is not null then return replay; end if;
 insert into public.orders(scenario_id,merchant_id,total_cents,customer_tender_cents,remaining_tender_cents,refundable_cents)
 values(p_scenario,m,p_total,p_total,p_total,p_total) returning * into o;
 return public.ot_idempotency_save(p_scenario,'create_order',p_key,p_hash,to_jsonb(o));
end $$;

drop function if exists public.ot_roundup(uuid,boolean,boolean,uuid,text);
create function public.ot_roundup(p_order uuid,p_succeeded boolean,p_accept_roundup boolean,p_key uuid,p_hash text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare o public.orders%rowtype; s public.demo_scenarios%rowtype; v_credit bigint; out jsonb;
begin
 select scenario_id into o.scenario_id from public.orders where id=p_order;
 if not found then raise exception 'ORDER_NOT_FOUND'; end if;
 select * into s from public.demo_scenarios where id=o.scenario_id for update;
 if not found or s.expires_at<=clock_timestamp() then raise exception 'SCENARIO_EXPIRED'; end if;
 select * into o from public.orders where id=p_order and scenario_id=s.id for update;
 if o.status<>'open' then raise exception 'ORDER_CLOSED'; end if;
 out:=public.ot_idempotency_replay(s.id,'roundup',p_key,p_hash); if out is not null then return out; end if;
 if not p_succeeded then
   update public.orders set status='payment_failed' where id=o.id;
   out:=jsonb_build_object('status','DECLINED','contributionCents',0);
   return public.ot_idempotency_save(s.id,'roundup',p_key,p_hash,out);
 end if;
 if not p_accept_roundup then v_credit:=0;
 else v_credit := case when mod(o.total_cents,50)=0 then 20 else 50-mod(o.total_cents,50) end;
 end if;
 update public.orders set status='completed',remaining_tender_cents=0 where id=o.id;
 if v_credit>0 then
   update public.demo_scenarios set settled_pool_cents=settled_pool_cents+v_credit,activated=activated or settled_pool_cents+v_credit>=activation_threshold_cents where id=s.id;
   insert into public.ledger_entries(scenario_id,order_id,merchant_id,kind,amount_cents,idempotency_operation,idempotency_key)
   values(s.id,o.id,o.merchant_id,'roundup_credit',v_credit,'roundup',p_key);
 end if;
 out:=jsonb_build_object('status','COMPLETED','contributionCents',v_credit);
 return public.ot_idempotency_save(s.id,'roundup',p_key,p_hash,out);
end $$;
