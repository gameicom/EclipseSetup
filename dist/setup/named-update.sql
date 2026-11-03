-- Named timers are independent from field timers and all server push functions.
-- Run once in the Supabase SQL Editor. Re-running preserves existing named times.
begin;

create or replace function public.eclipse_valid_named_bosses(p_value jsonb)
returns boolean language plpgsql immutable set search_path='' as $$
declare v_item jsonb; v_time timestamp; v_level integer; v_seen integer[]:='{}';
begin
 if jsonb_typeof(p_value) is distinct from 'array'
  or jsonb_array_length(p_value) not between 1 and 64
  or octet_length(p_value::text)>32768 then return false; end if;
 for v_item in select jsonb_array_elements(p_value) loop
  if jsonb_typeof(v_item) is distinct from 'object'
   or (v_item-array['level','interval_seconds','anchor_kst'])<>'{}'::jsonb
   or jsonb_typeof(v_item->'level') is distinct from 'number'
   or (v_item->>'level')!~'^[0-9]{1,3}$'
   or jsonb_typeof(v_item->'interval_seconds') is distinct from 'number'
   or (v_item->>'interval_seconds')!~'^[0-9]{1,7}$'
   or (v_item->>'interval_seconds')::integer not between 1 and 3599999
   or jsonb_typeof(v_item->'anchor_kst') is distinct from 'string'
   or (v_item->>'anchor_kst')!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}$'
  then return false; end if;
  v_level:=(v_item->>'level')::integer;
  if v_level<1 or v_level=any(v_seen) then return false; end if;
  v_seen:=array_append(v_seen,v_level);
  v_time:=(v_item->>'anchor_kst')::timestamp;
  if extract(year from v_time) not between 2000 and 2090
   or to_char(v_time,'YYYY-MM-DD"T"HH24:MI:SS')<>v_item->>'anchor_kst'
  then return false; end if;
 end loop;
 return true;
exception when others then return false;
end;
$$;

create table if not exists public.eclipse_named_timer_state (
 id integer primary key check(id=1),
 bosses jsonb not null check(public.eclipse_valid_named_bosses(bosses)),
 revision bigint not null default 0 check(revision>=0),
 updated_at timestamptz not null default clock_timestamp(),
 last_action text not null default 'initial' check(last_action in ('initial','add','edit','reset','import','undo')),
 client_id uuid
);
insert into public.eclipse_named_timer_state(id,bosses)
select 1,jsonb_agg(jsonb_build_object('level',level,'interval_seconds',1800,
 'anchor_kst',to_char(timezone('Asia/Seoul',now()),'YYYY-MM-DD"T"HH24:MI:SS')) order by level)
from unnest(array[71,72,73,74]) level
on conflict(id) do nothing;

alter table public.eclipse_named_timer_state enable row level security;
revoke all on public.eclipse_named_timer_state from public,anon,authenticated;
grant select on public.eclipse_named_timer_state to anon,authenticated;
drop policy if exists eclipse_named_public_read on public.eclipse_named_timer_state;
create policy eclipse_named_public_read on public.eclipse_named_timer_state for select
to anon,authenticated using(id=1);

create or replace function public.eclipse_read_named_timers()
returns jsonb language sql volatile security invoker set search_path='' as $$
 select jsonb_build_object('snapshot',to_jsonb(s),'server_now',clock_timestamp())
 from public.eclipse_named_timer_state s where id=1;
$$;

create or replace function public.eclipse_update_named_timers(
 p_bosses jsonb,p_base jsonb,p_levels integer[],p_action text,p_client_id uuid
)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_current public.eclipse_named_timer_state%rowtype; v_bosses jsonb;
 v_level integer; v_before jsonb; v_existing jsonb; v_item jsonb; v_reset text;
begin
 if not public.eclipse_valid_named_bosses(p_bosses) or not public.eclipse_valid_named_bosses(p_base)
  or p_bosses is null or p_base is null or p_levels is null
  or array_ndims(p_levels) is distinct from 1 or cardinality(p_levels) not between 1 and 64
  or exists(select 1 from unnest(p_levels) x where x is null or x not between 1 and 999)
  or (select count(distinct x) from unnest(p_levels) x)<>cardinality(p_levels)
  or p_action is null or p_action not in ('add','edit','reset','import','undo')
  or (p_action='add' and cardinality(p_levels)<>1) or p_client_id is null
 then raise exception 'INVALID_NAMED_SETTINGS' using errcode='22023'; end if;
 select * into strict v_current from public.eclipse_named_timer_state where id=1 for update;
 v_bosses:=v_current.bosses;
 v_reset:=to_char(timezone('Asia/Seoul',clock_timestamp()),'YYYY-MM-DD"T"HH24:MI:SS');
 foreach v_level in array p_levels loop
  select b into v_before from jsonb_array_elements(p_base) b where (b->>'level')::integer=v_level;
  select b into v_existing from jsonb_array_elements(v_current.bosses) b where (b->>'level')::integer=v_level;
  select b into v_item from jsonb_array_elements(p_bosses) b where (b->>'level')::integer=v_level;
  if v_item is null or (p_action='add' and v_before is not null)
   or (p_action not in ('add','import') and v_before is null)
  then raise exception 'INVALID_NAMED_SETTINGS' using errcode='22023'; end if;
  if v_existing is distinct from v_before then
   return jsonb_build_object('status','conflict','conflicting_levels',jsonb_build_array(v_level),
    'snapshot',to_jsonb(v_current),'server_now',clock_timestamp());
  end if;
  if p_action='reset' then
   v_item:=jsonb_set(v_existing,'{anchor_kst}',to_jsonb(v_reset));
  end if;
  select coalesce(jsonb_agg(b),'[]'::jsonb) into v_bosses
   from jsonb_array_elements(v_bosses) b where (b->>'level')::integer<>v_level;
  v_bosses:=v_bosses||jsonb_build_array(v_item);
 end loop;
 if jsonb_array_length(v_bosses)>64 then raise exception 'NAMED_BOSS_LIMIT' using errcode='22023'; end if;
 select jsonb_agg(b order by (b->>'level')::integer) into v_bosses from jsonb_array_elements(v_bosses) b;
 if v_bosses is distinct from v_current.bosses then
  update public.eclipse_named_timer_state set bosses=v_bosses,revision=revision+1,
   updated_at=clock_timestamp(),last_action=p_action,client_id=p_client_id
  where id=1 returning * into v_current;
 end if;
 return jsonb_build_object('status','ok','snapshot',to_jsonb(v_current),'server_now',clock_timestamp());
end;
$$;
revoke all on function public.eclipse_read_named_timers() from public;
revoke all on function public.eclipse_update_named_timers(jsonb,jsonb,integer[],text,uuid) from public;
grant execute on function public.eclipse_read_named_timers(),
 public.eclipse_update_named_timers(jsonb,jsonb,integer[],text,uuid) to anon,authenticated;

do $$
begin
 if exists(select 1 from pg_publication where pubname='supabase_realtime')
  and not exists(select 1 from pg_publication_tables where pubname='supabase_realtime'
   and schemaname='public' and tablename='eclipse_named_timer_state')
 then alter publication supabase_realtime add table public.eclipse_named_timer_state; end if;
end $$;
commit;
