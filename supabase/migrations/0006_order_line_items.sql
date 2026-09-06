-- Preserve the catalog identity selected at checkout. Prices are not a safe
-- product identifier (the bakery has two distinct €4.50 items).
alter table public.orders add column if not exists line_items jsonb not null default '[]'::jsonb;

drop function if exists public.ot_create_order(uuid,text,bigint,uuid,text);
create or replace function public.ot_create_order(p_scenario uuid,p_merchant text,p_total bigint,p_items jsonb,p_key uuid,p_hash text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare m uuid; o public.orders%rowtype; replay jsonb;
begin
 select id into m from public.merchants where scenario_id=p_scenario and slug=p_merchant;
 if not found then raise exception 'MERCHANT_NOT_FOUND'; end if;
 replay:=public.ot_idempotency_replay(p_scenario,'create_order',p_key,p_hash); if replay is not null then return replay; end if;
 insert into public.orders(scenario_id,merchant_id,total_cents,line_items,customer_tender_cents,remaining_tender_cents,refundable_cents)
 values(p_scenario,m,p_total,coalesce(p_items,'[]'::jsonb),p_total,p_total,p_total) returning * into o;
 return public.ot_idempotency_save(p_scenario,'create_order',p_key,p_hash,to_jsonb(o));
end $$;
revoke all on function public.ot_create_order(uuid,text,bigint,jsonb,uuid,text) from public, anon, authenticated;
grant execute on function public.ot_create_order(uuid,text,bigint,jsonb,uuid,text) to service_role;
