-- Shared public timer: every visitor can read and edit through the narrow RPC.
-- Run once in the Supabase SQL Editor. Re-running preserves the existing timers.
begin;

create or replace function public.eclipse_valid_bosses(p_value jsonb)
returns boolean language plpgsql immutable set search_path = '' as $$
declare
  v_item jsonb;
  v_index integer;
  v_levels integer[] := array[40,50,60,70,75,80];
  v_time timestamp;
begin
  if jsonb_typeof(p_value) is distinct from 'array'
     or jsonb_array_length(p_value) <> 6
     or octet_length(p_value::text) > 8192 then return false; end if;
  for v_index in 0..5 loop
    v_item := p_value -> v_index;
    if jsonb_typeof(v_item) is distinct from 'object'
       or (v_item - array['level','interval_seconds','anchor_kst']) <> '{}'::jsonb
       or jsonb_typeof(v_item->'level') is distinct from 'number'
       or v_item->>'level' <> v_levels[v_index+1]::text
       or jsonb_typeof(v_item->'interval_seconds') is distinct from 'number'
       or (v_item->>'interval_seconds') !~ '^[0-9]{1,7}$'
       or (v_item->>'interval_seconds')::integer not between 1 and 3599999
       or jsonb_typeof(v_item->'anchor_kst') is distinct from 'string'
       or (v_item->>'anchor_kst') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}$'
    then return false; end if;
    v_time := (v_item->>'anchor_kst')::timestamp;
    if extract(year from v_time) not between 2000 and 2090
       or to_char(v_time, 'YYYY-MM-DD"T"HH24:MI:SS') <> v_item->>'anchor_kst'
    then return false; end if;
  end loop;
  return true;
exception when others then return false;
end;
$$;

create table if not exists public.eclipse_timer_state (
  id integer primary key check (id = 1),
  bosses jsonb not null check (public.eclipse_valid_bosses(bosses)),
  revision bigint not null default 0 check (revision >= 0),
  updated_at timestamptz not null default clock_timestamp(),
  last_action text not null default 'initial' check (last_action in ('initial','edit','reset','import','undo')),
  client_id uuid
);

insert into public.eclipse_timer_state(id,bosses) values (1,'[
  {"level":40,"interval_seconds":28800,"anchor_kst":"2026-10-22T18:02:00"},
  {"level":50,"interval_seconds":28800,"anchor_kst":"2026-10-22T18:04:00"},
  {"level":60,"interval_seconds":36000,"anchor_kst":"2026-10-22T14:03:00"},
  {"level":70,"interval_seconds":43200,"anchor_kst":"2026-10-22T18:05:00"},
  {"level":75,"interval_seconds":43200,"anchor_kst":"2026-10-22T18:15:00"},
  {"level":80,"interval_seconds":54000,"anchor_kst":"2026-10-22T00:18:00"}
]'::jsonb) on conflict (id) do nothing;

alter table public.eclipse_timer_state enable row level security;
revoke all on public.eclipse_timer_state from public, anon, authenticated;
grant select on public.eclipse_timer_state to anon, authenticated;
drop policy if exists eclipse_public_read on public.eclipse_timer_state;
create policy eclipse_public_read on public.eclipse_timer_state for select
to anon, authenticated using (id = 1);

create or replace function public.eclipse_read_timers()
returns jsonb language sql volatile security invoker set search_path = '' as $$
  select jsonb_build_object('snapshot',to_jsonb(s),'server_now',clock_timestamp())
  from public.eclipse_timer_state s where id = 1;
$$;

create or replace function public.eclipse_update_timers(
  p_bosses jsonb, p_base jsonb, p_levels integer[], p_action text, p_client_id uuid
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_current public.eclipse_timer_state%rowtype;
  v_bosses jsonb;
  v_item jsonb;
  v_index integer;
  v_level integer;
  v_reset_anchor text;
begin
  if not public.eclipse_valid_bosses(p_bosses) or not public.eclipse_valid_bosses(p_base)
     or p_bosses is null or p_base is null
     or p_levels is null or array_ndims(p_levels) is distinct from 1
     or cardinality(p_levels) not between 1 and 6
     or exists (select 1 from unnest(p_levels) x where x is null or x not in (40,50,60,70,75,80))
     or (select count(distinct x) from unnest(p_levels) x) <> cardinality(p_levels)
     or p_action is null or p_action not in ('edit','reset','import','undo')
     or p_client_id is null
  then raise exception 'INVALID_TIMER_SETTINGS' using errcode = '22023'; end if;

  select * into strict v_current from public.eclipse_timer_state where id = 1 for update;
  v_bosses := v_current.bosses;
  v_reset_anchor := to_char(timezone('Asia/Seoul',clock_timestamp()),'YYYY-MM-DD"T"HH24:MI:SS');
  for v_index in 0..5 loop
    v_level := (v_current.bosses->v_index->>'level')::integer;
    if v_level = any(p_levels) then
      if v_current.bosses->v_index is distinct from p_base->v_index then
        return jsonb_build_object('status','conflict','conflicting_levels',jsonb_build_array(v_level),
          'snapshot',to_jsonb(v_current),'server_now',clock_timestamp());
      end if;
      if p_action = 'reset' then
        v_item := jsonb_set(v_current.bosses->v_index, '{anchor_kst}', to_jsonb(v_reset_anchor));
      else
        v_item := p_bosses->v_index;
      end if;
      v_bosses := jsonb_set(v_bosses,array[v_index::text],v_item);
    end if;
  end loop;

  if v_bosses is distinct from v_current.bosses then
    update public.eclipse_timer_state set bosses = v_bosses, revision = revision+1,
      updated_at = clock_timestamp(), last_action = p_action, client_id = p_client_id
    where id = 1 returning * into v_current;
  end if;
  return jsonb_build_object('status','ok','snapshot',to_jsonb(v_current),'server_now',clock_timestamp());
end;
$$;

revoke all on function public.eclipse_read_timers() from public;
revoke all on function public.eclipse_update_timers(jsonb,jsonb,integer[],text,uuid) from public;
grant execute on function public.eclipse_read_timers() to anon, authenticated;
grant execute on function public.eclipse_update_timers(jsonb,jsonb,integer[],text,uuid) to anon, authenticated;

-- Supabase has this publication. Standalone test databases can omit it.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime'
       and schemaname = 'public' and tablename = 'eclipse_timer_state')
  then alter publication supabase_realtime add table public.eclipse_timer_state; end if;
end $$;
commit;
