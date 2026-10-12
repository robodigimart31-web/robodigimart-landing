begin;

alter table public.helix_pairing_requests add column if not exists magic_base bigint;
alter table public.helix_license_sessions add column if not exists magic_base bigint;
alter table public.helix_license_bindings add column if not exists magic_base bigint;
alter table public.helix_telemetry_deals add column if not exists occurred_at_broker timestamp without time zone;
alter table public.helix_completed_trades add column if not exists opened_at_broker timestamp without time zone;
alter table public.helix_completed_trades add column if not exists closed_at_broker timestamp without time zone;
create index if not exists helix_completed_trades_closed_broker_idx on public.helix_completed_trades(binding_id,closed_at_broker);

create table if not exists public.helix_telemetry_canary_allowlist (
  binding_id uuid primary key references public.helix_license_bindings(id) on delete cascade,
  expires_at timestamptz not null,
  note text not null default 'owner demo v1.8h canary',
  created_at timestamptz not null default now()
);
alter table public.helix_telemetry_canary_allowlist enable row level security;
revoke all on public.helix_telemetry_canary_allowlist from anon,authenticated;
grant select,insert,update,delete on public.helix_telemetry_canary_allowlist to service_role;

create table if not exists public.helix_general_settings (
  setting_key text primary key,
  setting_value jsonb not null,
  updated_at timestamptz not null default now(),
  updated_by uuid references public.helix_members(id),
  change_reason text
);
alter table public.helix_general_settings enable row level security;
revoke all on public.helix_general_settings from anon,authenticated;
grant select,insert,update,delete on public.helix_general_settings to service_role;
insert into public.helix_general_settings(setting_key,setting_value,change_reason)
values ('usd_idr_rate','17500'::jsonb,'Initial owner-provided conversion rate'),('usc_per_usd','100'::jsonb,'Initial owner-provided USC cent-account divisor')
on conflict(setting_key) do nothing;

create or replace function public.helix_session_set_magic_base(p_session_hash text,p_magic_base bigint)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare s public.helix_license_sessions; b public.helix_license_bindings; l public.helix_licenses; pr public.helix_pairing_requests; v_now timestamptz:=now();
begin
  if p_magic_base is null or p_magic_base<1 or p_magic_base>9007199254740944 then return jsonb_build_object('ok',false,'error_code','INVALID_MAGIC_BASE'); end if;
  select * into s from public.helix_license_sessions where session_secret_hash=p_session_hash and revoked_at is null for update;
  if found then
    if s.expires_at is null or s.expires_at<=v_now then return jsonb_build_object('ok',false,'error_code','SESSION_EXPIRED'); end if;
    select * into l from public.helix_licenses where id=s.license_id for share;
    if not found or l.status<>'active' or l.deleted_at is not null or (l.expires_at is not null and l.expires_at<=v_now) then return jsonb_build_object('ok',false,'error_code','LICENSE_NOT_ACTIVE'); end if;
    select * into b from public.helix_license_bindings where id=s.binding_id for update;
    if not found or b.released_at is not null or b.license_id<>s.license_id then return jsonb_build_object('ok',false,'error_code','BINDING_RELEASED'); end if;
    if s.magic_base is not null and s.magic_base<>p_magic_base then return jsonb_build_object('ok',false,'error_code','MAGIC_BASE_CONFLICT'); end if;
    if b.magic_base is not null and b.magic_base<>p_magic_base then return jsonb_build_object('ok',false,'error_code','MAGIC_BASE_CONFLICT'); end if;
    update public.helix_license_sessions set magic_base=p_magic_base,last_seen_at=v_now where id=s.id;
    update public.helix_license_bindings set magic_base=p_magic_base where id=b.id;
    return jsonb_build_object('ok',true,'binding_id',b.id,'magic_base',p_magic_base);
  end if;
  select * into pr from public.helix_pairing_requests where session_secret_hash=p_session_hash and state='pending' and expires_at>v_now for update;
  if not found then return jsonb_build_object('ok',false,'error_code','INVALID_SESSION'); end if;
  if pr.magic_base is not null and pr.magic_base<>p_magic_base then return jsonb_build_object('ok',false,'error_code','MAGIC_BASE_CONFLICT'); end if;
  update public.helix_pairing_requests set magic_base=p_magic_base where id=pr.id;
  return jsonb_build_object('ok',true,'pairing_request_id',pr.id,'magic_base',p_magic_base);
end $$;

create or replace function public.helix_sync_magic_base_after_session_insert()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare v_base bigint;
begin
  select magic_base into v_base from public.helix_pairing_requests where id=new.pairing_request_id;
  if v_base is not null then
    update public.helix_license_sessions set magic_base=v_base where id=new.id;
    update public.helix_license_bindings set magic_base=coalesce(magic_base,v_base) where id=new.binding_id and (magic_base is null or magic_base=v_base);
  end if;
  return new;
end $$;
drop trigger if exists helix_sync_magic_base_after_session_insert on public.helix_license_sessions;
create trigger helix_sync_magic_base_after_session_insert after insert on public.helix_license_sessions
for each row execute function public.helix_sync_magic_base_after_session_insert();

create or replace function public.helix_ingest_telemetry_deals_v2(p_session_hash text,p_magic_base bigint,p_deals jsonb,p_global_enabled boolean default false)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare s public.helix_license_sessions; l public.helix_licenses; b public.helix_license_bindings; d jsonb; n integer:=0; pos text; total_vol numeric; pnl numeric; ccy_count integer; ccy text; sym text; has_entry boolean; foreign_entry boolean; unsupported boolean; opened timestamp; closed timestamp; v_magic bigint; v_time timestamp;
begin
  if p_magic_base is null or p_magic_base<1 or p_magic_base>9007199254740944 or jsonb_typeof(p_deals)<>'array' or jsonb_array_length(p_deals)<1 or jsonb_array_length(p_deals)>180 then return jsonb_build_object('ok',false,'error_code','INVALID_BATCH'); end if;
  select * into s from public.helix_license_sessions where session_secret_hash=p_session_hash and revoked_at is null for update;
  if not found then return jsonb_build_object('ok',false,'error_code','SESSION_REVOKED'); end if;
  if s.expires_at is null or s.expires_at<=now() then return jsonb_build_object('ok',false,'error_code','SESSION_EXPIRED'); end if;
  select * into l from public.helix_licenses where id=s.license_id for update;
  if not found or l.status<>'active' or l.deleted_at is not null or (l.expires_at is not null and l.expires_at<=now()) then return jsonb_build_object('ok',false,'error_code','LICENSE_NOT_ACTIVE'); end if;
  select * into b from public.helix_license_bindings where id=s.binding_id for update;
  if not found or b.released_at is not null or b.license_id<>l.id then return jsonb_build_object('ok',false,'error_code','BINDING_RELEASED'); end if;
  if s.magic_base is null or s.magic_base<>p_magic_base or b.magic_base is null or b.magic_base<>p_magic_base then return jsonb_build_object('ok',false,'error_code','MAGIC_BASE_MISMATCH'); end if;
  if not p_global_enabled and (b.mode<>'demo' or not exists(select 1 from public.helix_telemetry_canary_allowlist c where c.binding_id=b.id and c.expires_at>now())) then return jsonb_build_object('ok',false,'error_code','TELEMETRY_NOT_ALLOWED'); end if;
  for d in select value from jsonb_array_elements(p_deals) loop
    if d->>'entry_kind' not in ('IN','OUT') or d->>'direction' not in ('BUY','SELL') or (d->>'occurred_at_broker') !~ '^202[6-9]-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}$' then return jsonb_build_object('ok',false,'error_code','UNSUPPORTED_DEAL_LIFECYCLE'); end if;
    v_magic:=(d->>'magic')::bigint; v_time:=(d->>'occurred_at_broker')::timestamp without time zone;
    if v_time<timestamp '2026-09-01 00:00:00' or v_time>timestamp '2100-01-01' then return jsonb_build_object('ok',false,'error_code','BROKER_TIME_OUT_OF_RANGE'); end if;
    if (d->>'entry_kind'='IN' and (v_magic<p_magic_base+1 or v_magic>p_magic_base+47)) or (d->>'entry_kind'='OUT' and v_magic<>0 and (v_magic<p_magic_base+1 or v_magic>p_magic_base+47)) then return jsonb_build_object('ok',false,'error_code','MAGIC_OUT_OF_RANGE'); end if;
    insert into public.helix_telemetry_deals(binding_id,deal_ticket,position_id,occurred_at,occurred_at_broker,direction,entry_kind,volume,profit,commission,swap,fee,currency,symbol,magic)
    values(b.id,d->>'deal_ticket',d->>'position_id',v_time at time zone 'UTC',v_time,d->>'direction',d->>'entry_kind',(d->>'volume')::numeric,(d->>'profit')::numeric,(d->>'commission')::numeric,(d->>'swap')::numeric,(d->>'fee')::numeric,d->>'currency',d->>'symbol',v_magic)
    on conflict(binding_id,deal_ticket) do update set position_id=excluded.position_id,occurred_at=excluded.occurred_at,occurred_at_broker=excluded.occurred_at_broker,direction=excluded.direction,entry_kind=excluded.entry_kind,volume=excluded.volume,profit=excluded.profit,commission=excluded.commission,swap=excluded.swap,fee=excluded.fee,currency=excluded.currency,symbol=excluded.symbol,magic=excluded.magic
    where public.helix_telemetry_deals.position_id is distinct from excluded.position_id or public.helix_telemetry_deals.occurred_at_broker is distinct from excluded.occurred_at_broker or public.helix_telemetry_deals.direction is distinct from excluded.direction or public.helix_telemetry_deals.entry_kind is distinct from excluded.entry_kind or public.helix_telemetry_deals.volume is distinct from excluded.volume or public.helix_telemetry_deals.profit is distinct from excluded.profit or public.helix_telemetry_deals.commission is distinct from excluded.commission or public.helix_telemetry_deals.swap is distinct from excluded.swap or public.helix_telemetry_deals.fee is distinct from excluded.fee or public.helix_telemetry_deals.currency is distinct from excluded.currency or public.helix_telemetry_deals.symbol is distinct from excluded.symbol or public.helix_telemetry_deals.magic is distinct from excluded.magic;
    n:=n+1;
  end loop;
  for pos in select distinct value->>'position_id' from jsonb_array_elements(p_deals) loop
    select coalesce(sum(case when direction='BUY' then volume else -volume end),0),coalesce(sum(profit+commission+swap+fee),0),count(distinct currency),min(currency),min(symbol),min(occurred_at_broker) filter(where entry_kind='IN'),max(occurred_at_broker) filter(where entry_kind='OUT'),bool_or(entry_kind='IN' and magic between p_magic_base+1 and p_magic_base+47),bool_or(entry_kind='IN' and not(magic between p_magic_base+1 and p_magic_base+47)),bool_or(entry_kind not in ('IN','OUT'))
    into total_vol,pnl,ccy_count,ccy,sym,opened,closed,has_entry,foreign_entry,unsupported
    from public.helix_telemetry_deals where binding_id=b.id and position_id=pos and occurred_at_broker>=timestamp '2026-09-01 00:00:00';
    if coalesce(unsupported,false) or coalesce(foreign_entry,true) or coalesce(ccy_count,0)<>1 then delete from public.helix_completed_trades where binding_id=b.id and position_id=pos;
    elsif abs(total_vol)<=0.0000001 and coalesce(has_entry,false) and closed is not null then
      insert into public.helix_completed_trades(binding_id,position_id,currency,symbol,net_pnl,outcome,family,opened_at,closed_at,opened_at_broker,closed_at_broker,updated_at)
      values(b.id,pos,ccy,sym,pnl,case when pnl>0.000001 then 'win' when pnl< -0.000001 then 'loss' else 'break_even' end,null,opened at time zone 'UTC',closed at time zone 'UTC',opened,closed,now())
      on conflict(binding_id,position_id) do update set currency=excluded.currency,symbol=excluded.symbol,net_pnl=excluded.net_pnl,outcome=excluded.outcome,opened_at=excluded.opened_at,closed_at=excluded.closed_at,opened_at_broker=excluded.opened_at_broker,closed_at_broker=excluded.closed_at_broker,updated_at=now();
    else delete from public.helix_completed_trades where binding_id=b.id and position_id=pos;
    end if;
  end loop;
  update public.helix_license_sessions set last_seen_at=now(),last_telemetry_sync_at=now() where id=s.id;
  return jsonb_build_object('ok',true,'accepted',n,'updated_trades',(select count(*) from public.helix_completed_trades where binding_id=b.id),'synced_at',now());
end $$;

create or replace function public.helix_member_performance_summary_v2(p_member_id uuid,p_license_id uuid default null,p_binding_id uuid default null,p_from timestamp without time zone default null,p_to timestamp without time zone default null)
returns jsonb language sql security definer set search_path=public,pg_temp as $$
 select jsonb_build_object('status',case when count(*)=0 then 'NO_DATA' else 'READY' end,
  'by_currency',coalesce(jsonb_agg(jsonb_build_object('currency',q.currency,'trades',q.trades,'wins',q.wins,'losses',q.losses,'break_even',q.break_even,'gross_profit',q.gross_profit,'gross_loss',q.gross_loss,'net_pnl',q.net_pnl,'last_sync_at',q.last_sync_at) order by q.currency),'[]'::jsonb),
  'last_sync_at',max(q.last_sync_at))
 from (select t.currency,count(*)::integer trades,count(*) filter(where t.outcome='win')::integer wins,count(*) filter(where t.outcome='loss')::integer losses,count(*) filter(where t.outcome='break_even')::integer break_even,coalesce(sum(t.net_pnl) filter(where t.net_pnl>0),0) gross_profit,abs(coalesce(sum(t.net_pnl) filter(where t.net_pnl<0),0)) gross_loss,sum(t.net_pnl) net_pnl,(select max(s.last_telemetry_sync_at) from public.helix_license_sessions s where s.binding_id=b.id) last_sync_at
 from public.helix_completed_trades t join public.helix_license_bindings b on b.id=t.binding_id join public.helix_licenses l on l.id=b.license_id
 where l.member_id=p_member_id and b.released_at is null and l.deleted_at is null and (p_license_id is null or l.id=p_license_id) and (p_binding_id is null or b.id=p_binding_id) and (p_from is null or t.closed_at_broker>=greatest(p_from,timestamp '2026-09-01 00:00:00')) and (p_to is null or t.closed_at_broker<p_to)
 group by t.currency,b.id) q;
$$;

create or replace function public.helix_member_performance_daily_v2(p_member_id uuid,p_license_id uuid default null,p_binding_id uuid default null,p_from timestamp without time zone default null,p_to timestamp without time zone default null)
returns jsonb language sql security definer set search_path=public,pg_temp as $$
 select coalesce(jsonb_agg(jsonb_build_object('broker_date',d.broker_date,'currency',d.currency,'net_pnl',d.net_pnl,'trades',d.trades) order by d.broker_date),'[]'::jsonb)
 from (select t.closed_at_broker::date broker_date,t.currency,round(sum(t.net_pnl),8) net_pnl,count(*)::integer trades
 from public.helix_completed_trades t join public.helix_license_bindings b on b.id=t.binding_id join public.helix_licenses l on l.id=b.license_id
 where l.member_id=p_member_id and b.released_at is null and l.deleted_at is null and (p_license_id is null or l.id=p_license_id) and (p_binding_id is null or b.id=p_binding_id) and t.closed_at_broker>=greatest(coalesce(p_from,timestamp '2026-09-01 00:00:00'),timestamp '2026-09-01 00:00:00') and (p_to is null or t.closed_at_broker<p_to)
 group by t.closed_at_broker::date,t.currency) d;
$$;

create or replace function public.helix_member_performance_canary_summary_v2(p_member_id uuid,p_license_id uuid default null,p_binding_id uuid default null,p_from timestamp without time zone default null,p_to timestamp without time zone default null)
returns jsonb language sql security definer set search_path=public,pg_temp as $$
 select jsonb_build_object('status',case when count(*)=0 then 'NO_DATA' else 'READY' end,
  'by_currency',coalesce(jsonb_agg(jsonb_build_object('currency',q.currency,'trades',q.trades,'wins',q.wins,'losses',q.losses,'break_even',q.break_even,'gross_profit',q.gross_profit,'gross_loss',q.gross_loss,'net_pnl',q.net_pnl,'last_sync_at',q.last_sync_at) order by q.currency),'[]'::jsonb),
  'last_sync_at',max(q.last_sync_at))
 from (select t.currency,count(*)::integer trades,count(*) filter(where t.outcome='win')::integer wins,count(*) filter(where t.outcome='loss')::integer losses,count(*) filter(where t.outcome='break_even')::integer break_even,coalesce(sum(t.net_pnl) filter(where t.net_pnl>0),0) gross_profit,abs(coalesce(sum(t.net_pnl) filter(where t.net_pnl<0),0)) gross_loss,sum(t.net_pnl) net_pnl,(select max(s.last_telemetry_sync_at) from public.helix_license_sessions s where s.binding_id=b.id) last_sync_at
 from public.helix_completed_trades t join public.helix_license_bindings b on b.id=t.binding_id join public.helix_licenses l on l.id=b.license_id
 where l.member_id=p_member_id and b.released_at is null and l.deleted_at is null and (p_license_id is null or l.id=p_license_id) and (p_binding_id is null or b.id=p_binding_id) and (p_from is null or t.closed_at_broker>=greatest(p_from,timestamp '2026-09-01 00:00:00')) and (p_to is null or t.closed_at_broker<p_to) and exists(select 1 from public.helix_telemetry_canary_allowlist c where c.binding_id=b.id and c.expires_at>now())
 group by t.currency,b.id) q;
$$;

create or replace function public.helix_member_performance_canary_daily_v2(p_member_id uuid,p_license_id uuid default null,p_binding_id uuid default null,p_from timestamp without time zone default null,p_to timestamp without time zone default null)
returns jsonb language sql security definer set search_path=public,pg_temp as $$
 select coalesce(jsonb_agg(jsonb_build_object('broker_date',d.broker_date,'currency',d.currency,'net_pnl',d.net_pnl,'trades',d.trades) order by d.broker_date),'[]'::jsonb)
 from (select t.closed_at_broker::date broker_date,t.currency,round(sum(t.net_pnl),8) net_pnl,count(*)::integer trades
 from public.helix_completed_trades t join public.helix_license_bindings b on b.id=t.binding_id join public.helix_licenses l on l.id=b.license_id
 where l.member_id=p_member_id and b.released_at is null and l.deleted_at is null and (p_license_id is null or l.id=p_license_id) and (p_binding_id is null or b.id=p_binding_id) and t.closed_at_broker>=greatest(coalesce(p_from,timestamp '2026-09-01 00:00:00'),timestamp '2026-09-01 00:00:00') and (p_to is null or t.closed_at_broker<p_to) and exists(select 1 from public.helix_telemetry_canary_allowlist c where c.binding_id=b.id and c.expires_at>now())
 group by t.closed_at_broker::date,t.currency) d;
$$;

do $$ declare f text; begin
 foreach f in array array['helix_session_set_magic_base(text,bigint)','helix_sync_magic_base_after_session_insert()','helix_ingest_telemetry_deals_v2(text,bigint,jsonb,boolean)','helix_member_performance_summary_v2(uuid,uuid,uuid,timestamp without time zone,timestamp without time zone)','helix_member_performance_daily_v2(uuid,uuid,uuid,timestamp without time zone,timestamp without time zone)','helix_member_performance_canary_summary_v2(uuid,uuid,uuid,timestamp without time zone,timestamp without time zone)','helix_member_performance_canary_daily_v2(uuid,uuid,uuid,timestamp without time zone,timestamp without time zone)'] loop
  execute format('revoke all on function public.%s from public,anon,authenticated',f);
  execute format('grant execute on function public.%s to service_role',f);
 end loop;
end $$;

commit;
