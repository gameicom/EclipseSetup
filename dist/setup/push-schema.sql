-- Optional server push. Does not change shared boss times.
begin;
create table if not exists public.eclipse_push_config (
  id integer primary key check(id=1), enabled boolean not null default false,
  public_key text not null default '', last_checked timestamptz not null default clock_timestamp()
);
insert into public.eclipse_push_config(id) values(1) on conflict do nothing;
alter table public.eclipse_push_config add column if not exists broadcast_requested_at timestamptz;
create table if not exists public.eclipse_push_subscriptions (
  device_id uuid primary key, token_hash text not null, subscription jsonb not null,
  endpoint text not null unique, created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(), test_requested_at timestamptz
);
create table if not exists public.eclipse_push_jobs (
  id bigint generated always as identity primary key,
  device_id uuid not null references public.eclipse_push_subscriptions(device_id) on delete cascade,
  event_key text not null, payload jsonb not null, due_at timestamptz not null,
  boss jsonb, attempts integer not null default 0, leased_until timestamptz,
  sent_at timestamptz, unique(device_id,event_key)
);
create index if not exists eclipse_push_pending on public.eclipse_push_jobs(due_at) where sent_at is null;
alter table public.eclipse_push_config enable row level security;
alter table public.eclipse_push_subscriptions enable row level security;
alter table public.eclipse_push_jobs enable row level security;
revoke all on public.eclipse_push_config,public.eclipse_push_subscriptions,public.eclipse_push_jobs from public,anon,authenticated;
revoke all on sequence public.eclipse_push_jobs_id_seq from public,anon,authenticated;

create or replace function public.eclipse_push_info()
returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object('enabled',enabled and last_checked > now()-interval '3 minutes',
   'public_key',public_key,'test_audience','all') from public.eclipse_push_config where id=1;
$$;
create or replace function public.eclipse_push_owns(p_device uuid,p_token text)
returns boolean language sql stable security definer set search_path='' as $$
 select coalesce(length(p_token)=43 and exists(select 1 from public.eclipse_push_subscriptions
 where device_id=p_device and token_hash=encode(sha256(convert_to(p_token,'UTF8')),'hex')),false);
$$;
create or replace function public.eclipse_push_status(p_device uuid,p_token text)
returns boolean language sql stable security definer set search_path='' as $$
 select public.eclipse_push_owns(p_device,p_token);
$$;
revoke all on function public.eclipse_push_status(uuid,text) from public;
grant execute on function public.eclipse_push_status(uuid,text) to anon,authenticated;
create or replace function public.eclipse_push_save(p_device uuid,p_token text,p_subscription jsonb)
returns boolean language plpgsql security definer set search_path='' as $$
declare v_endpoint text:=p_subscription->>'endpoint'; v_clean jsonb;
begin
 if p_device is null or p_token is null or p_token !~ '^[A-Za-z0-9_-]{43}$'
 or p_subscription is null or octet_length(p_subscription::text)>4096
 or v_endpoint is null or length(v_endpoint)>2048
 or v_endpoint !~ '^https://(fcm[.]googleapis[.]com|([a-z0-9-]+[.])*push[.]services[.]mozilla[.]com|web[.]push[.]apple[.]com|[a-z0-9-]+[.]notify[.]windows[.]com)/[^[:space:]#]+$'
 or coalesce(p_subscription->'keys'->>'p256dh','') !~ '^[A-Za-z0-9_-]{87}$'
 or coalesce(p_subscription->'keys'->>'auth','') !~ '^[A-Za-z0-9_-]{22}$'
 then raise exception 'INVALID_PUSH_SUBSCRIPTION' using errcode='22023'; end if;
 if not exists(select 1 from public.eclipse_push_config where id=1 and enabled and public_key<>'')
 then raise exception 'PUSH_NOT_CONFIGURED'; end if;
 perform pg_advisory_xact_lock(8102201);
 if exists(select 1 from public.eclipse_push_subscriptions where device_id=p_device)
 and not public.eclipse_push_owns(p_device,p_token)
 then raise exception 'PUSH_ACCESS_DENIED' using errcode='42501'; end if;
 if not exists(select 1 from public.eclipse_push_subscriptions where device_id=p_device)
 and (select count(*) from public.eclipse_push_subscriptions)>=500
 then raise exception 'PUSH_DEVICE_LIMIT'; end if;
 v_clean:=jsonb_build_object('endpoint',v_endpoint,'keys',jsonb_build_object(
  'p256dh',p_subscription->'keys'->>'p256dh','auth',p_subscription->'keys'->>'auth'));
 insert into public.eclipse_push_subscriptions(device_id,token_hash,endpoint,subscription)
 values(p_device,encode(sha256(convert_to(p_token,'UTF8')),'hex'),v_endpoint,v_clean)
 on conflict(device_id) do update set subscription=excluded.subscription,
 endpoint=excluded.endpoint,updated_at=clock_timestamp();
 return true;
end;
$$;
create or replace function public.eclipse_push_remove(p_device uuid,p_token text)
returns boolean language plpgsql security definer set search_path='' as $$
begin
 if not exists(select 1 from public.eclipse_push_subscriptions where device_id=p_device) then return true; end if;
 if not public.eclipse_push_owns(p_device,p_token) then raise exception 'PUSH_ACCESS_DENIED' using errcode='42501'; end if;
 delete from public.eclipse_push_subscriptions where device_id=p_device;
 return true;
end;
$$;
create or replace function public.eclipse_push_test(p_device uuid,p_token text)
returns boolean language plpgsql security definer set search_path='' as $$
declare v_now timestamptz:=clock_timestamp(); v_level integer; v_due timestamptz;
begin
 if not public.eclipse_push_owns(p_device,p_token) then raise exception 'PUSH_ACCESS_DENIED' using errcode='42501'; end if;
 -- Serialize broadcasts across devices, sharing one cooldown for all recipients.
 perform 1 from public.eclipse_push_config where id=1 and enabled for update;
 if not found then raise exception 'PUSH_NOT_CONFIGURED'; end if;
 v_now:=clock_timestamp();
 if exists(select 1 from public.eclipse_push_config where id=1
  and broadcast_requested_at>=v_now-interval '1 minute')
 then raise exception 'WAIT_ONE_MINUTE'; end if;
 -- Select from current shared settings using server time, including future anchors.
 select level,due into v_level,v_due from (
  select level,case when anchor>v_now then anchor else
   anchor+((floor(extract(epoch from (v_now-anchor))/period)+1)*period)*interval '1 second'
   end as due
  from (
   select (b->>'level')::integer as level,
    (b->>'anchor_kst')::timestamp at time zone 'Asia/Seoul' as anchor,
    (b->>'interval_seconds')::integer as period
   from public.eclipse_timer_state s, jsonb_array_elements(s.bosses) b where s.id=1
  ) settings
 ) upcoming order by due,level limit 1;
 if not found then raise exception 'PUSH_TIMER_UNAVAILABLE'; end if;
 update public.eclipse_push_config set broadcast_requested_at=v_now where id=1;
 update public.eclipse_push_subscriptions set test_requested_at=v_now where device_id=p_device;
 insert into public.eclipse_push_jobs(device_id,event_key,payload,due_at)
 select device_id,'test:'||floor(extract(epoch from v_now)/60)::text,
 jsonb_build_object('title','[테스트] Lv.'||v_level||' 필드보스',
  'body','다음 리젠 · '||to_char(v_due at time zone 'Asia/Seoul','MM/DD HH24:MI:SS')||' (한국시간)',
  'tag','eclipse-push-test','timestamp',floor(extract(epoch from v_now)*1000)),
 v_now from public.eclipse_push_subscriptions on conflict do nothing;
 return true;
end;
$$;

-- Only a trusted scheduler can create deliveries and access subscription endpoints.
create or replace function public.eclipse_push_enqueue()
returns integer language plpgsql security definer set search_path='' as $$
declare v_now timestamptz:=clock_timestamp(); v_last timestamptz; v_boss jsonb; v_anchor timestamptz;
 v_due timestamptz; v_period integer; v_level integer; v_count integer:=0; v_inserted integer;
begin
 select last_checked into v_last from public.eclipse_push_config where id=1 and enabled for update;
 if not found then return 0; end if;
 for v_boss in select jsonb_array_elements(bosses) from public.eclipse_timer_state where id=1 loop
  v_anchor:=(v_boss->>'anchor_kst')::timestamp at time zone 'Asia/Seoul';
  v_period:=(v_boss->>'interval_seconds')::integer;
  v_level:=(v_boss->>'level')::integer;
  if v_anchor>v_now then continue; end if;
  v_due:=v_anchor+(floor(extract(epoch from (v_now-v_anchor))/v_period)*v_period)*interval '1 second';
  if v_due>greatest(v_last,v_now-interval '2 minutes') and v_due<=v_now then
   insert into public.eclipse_push_jobs(device_id,event_key,payload,due_at,boss)
   select device_id,'boss:'||v_level||':'||floor(extract(epoch from v_due))::text,
    jsonb_build_object('title','Lv.'||v_level||' 필드보스 리젠',
     'body',to_char(v_due at time zone 'Asia/Seoul','HH24:MI')||' · 설정된 리젠 시각입니다.',
     'tag','eclipse-boss-'||v_level||'-'||floor(extract(epoch from v_due))::text,
     'timestamp',floor(extract(epoch from v_due)*1000)),
    v_due,v_boss from public.eclipse_push_subscriptions where created_at<=v_due
   on conflict do nothing;
   get diagnostics v_inserted=row_count; v_count:=v_count+v_inserted;
  end if;
 end loop;
 update public.eclipse_push_config set last_checked=v_now where id=1;
 delete from public.eclipse_push_jobs where due_at<v_now-interval '2 days';
 return v_count;
end;
$$;
create or replace function public.eclipse_push_claim()
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_jobs jsonb;
begin
 if not exists(select 1 from public.eclipse_push_config where id=1 and enabled) then return '[]'::jsonb; end if;
 -- Discard queued alarms whose shared boss settings have since changed.
 delete from public.eclipse_push_jobs j where j.sent_at is null and j.boss is not null
 and not exists(select 1 from public.eclipse_timer_state s, jsonb_array_elements(s.bosses) b where b=j.boss);
 with candidates as (
  select id from public.eclipse_push_jobs where sent_at is null and attempts<3
   and due_at<=clock_timestamp() and due_at>clock_timestamp()-interval '5 minutes'
   and (leased_until is null or leased_until<clock_timestamp())
  order by due_at,id limit 100 for update skip locked
 ), claimed as (
  update public.eclipse_push_jobs j set leased_until=clock_timestamp()+interval '2 minutes',attempts=attempts+1
  from candidates c where j.id=c.id returning j.*
 )
 select coalesce(jsonb_agg(jsonb_build_object('id',c.id,'subscription',s.subscription,'payload',c.payload)),'[]'::jsonb)
 into v_jobs from claimed c join public.eclipse_push_subscriptions s using(device_id);
 return v_jobs;
end;
$$;
create or replace function public.eclipse_push_finish(p_id bigint,p_result text)
returns boolean language plpgsql security definer set search_path='' as $$
begin
 if p_result='gone' then
  delete from public.eclipse_push_subscriptions where device_id=(select device_id from public.eclipse_push_jobs where id=p_id);
 elsif p_result='sent' then
  update public.eclipse_push_jobs set sent_at=clock_timestamp() where id=p_id;
 elsif p_result='retry' then
  -- Keep the lease until its timeout to avoid immediate retries in the same dispatch.
  null;
 else raise exception 'INVALID_PUSH_RESULT'; end if;
 return true;
end;
$$;

revoke all on function public.eclipse_push_owns(uuid,text) from public,anon,authenticated;
revoke all on function public.eclipse_push_info() from public;
revoke all on function public.eclipse_push_save(uuid,text,jsonb) from public;
revoke all on function public.eclipse_push_remove(uuid,text) from public;
revoke all on function public.eclipse_push_test(uuid,text) from public;
revoke all on function public.eclipse_push_enqueue() from public,anon,authenticated;
revoke all on function public.eclipse_push_claim() from public,anon,authenticated;
revoke all on function public.eclipse_push_finish(bigint,text) from public,anon,authenticated;
grant execute on function public.eclipse_push_info() to anon,authenticated,service_role;
grant execute on function public.eclipse_push_save(uuid,text,jsonb),public.eclipse_push_remove(uuid,text),
 public.eclipse_push_test(uuid,text) to anon,authenticated;
grant execute on function public.eclipse_push_enqueue(),public.eclipse_push_claim(),
 public.eclipse_push_finish(bigint,text) to service_role;
commit;
