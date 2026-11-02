-- Upgrade scheduling without replacing keys, subscriptions or shared boss times.
-- Requires push.sql and the existing pg_cron, pg_net and Vault setup.
begin;

create or replace function public.eclipse_push_plan(p_now timestamptz default clock_timestamp())
returns timestamptz language plpgsql security definer set search_path='' as $$
declare v_config public.eclipse_push_config%rowtype; v_alarm timestamptz; v_pending timestamptz;
 v_next timestamptz; v_run_minute timestamptz; v_wall timestamp; v_schedule text; v_id bigint;
begin
 select * into strict v_config from public.eclipse_push_config where id=1 for update;
 if v_config.enabled and exists(select 1 from public.eclipse_push_subscriptions) then
  select min(public.eclipse_push_next_warning(b,p_now)) into v_alarm
   from public.eclipse_timer_state s,jsonb_array_elements(s.bosses) b where s.id=1;
  select min(ready_at) into v_pending from (
   select greatest(due_at,coalesce(leased_until,p_now),p_now,
    coalesce(v_config.dispatch_requested_at+interval '30 seconds',p_now)) as ready_at,
    coalesce(expires_at,due_at+interval '5 minutes') as expires
   from public.eclipse_push_jobs where sent_at is null and attempts<3
  ) pending where ready_at<expires;
  v_next:=least(v_alarm,v_pending);
 end if;
 if v_next is not null and v_next=v_config.wake_at and exists(
  select 1 from cron.job where jobid=v_config.wake_job_id and jobname='eclipse-boss-wake' and username=current_user
 ) then return v_next; end if;
 -- Recreate the job so a seconds interval starts from this reservation.
 for v_id in select jobid from cron.job where jobname='eclipse-boss-wake' and username=current_user loop
  perform cron.unschedule(v_id);
 end loop;
 if v_next is null then
  update public.eclipse_push_config set wake_at=null,wake_job_id=null where id=1;
  return null;
 end if;
 v_run_minute:=date_trunc('minute',v_next);
 if v_run_minute<=p_now then
  v_schedule:=greatest(1,least(59,ceil(extract(epoch from (v_next-p_now)))::integer))::text||' seconds';
 else
  v_wall:=v_run_minute at time zone coalesce(nullif(current_setting('cron.timezone',true),''),'GMT');
  v_schedule:=to_char(v_wall,'MI HH24 DD MM')||' *';
 end if;
 v_id:=cron.schedule('eclipse-boss-wake',v_schedule,
  format('select public.eclipse_push_wake(%L::timestamptz);',v_next));
 update public.eclipse_push_config set wake_at=v_next,wake_job_id=v_id where id=1;
 return v_next;
end;
$$;

create or replace function public.eclipse_push_tick()
returns void language plpgsql security definer set search_path='' as $$
declare v_config public.eclipse_push_config%rowtype; v_now timestamptz:=clock_timestamp(); v_secret text;
begin
 select * into strict v_config from public.eclipse_push_config where id=1 for update;
 if not v_config.enabled then perform public.eclipse_push_plan(v_now); return; end if;
 perform public.eclipse_push_enqueue();
 if exists(select 1 from public.eclipse_push_jobs where sent_at is null and attempts<3
  and due_at<=v_now and coalesce(expires_at,due_at+interval '5 minutes')>v_now
  and (leased_until is null or leased_until<=v_now)) then
  select decrypted_secret into v_secret from vault.decrypted_secrets where name='eclipse_push_dispatch';
  update public.eclipse_push_config set dispatch_requested_at=v_now where id=1;
  if v_secret is not null and v_config.function_url~'^https://[a-z]{20}[.]supabase[.]co/functions/v1/boss-push$' then
   perform net.http_post(url:=v_config.function_url,
    headers:=jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||v_secret),
    body:='{}'::jsonb,timeout_milliseconds:=50000);
  end if;
 end if;
 if v_config.housekeeping_at is null or v_config.housekeeping_at<=v_now-interval '1 hour' then
  delete from cron.job_run_details where end_time<v_now-interval '7 days'
   and (command='select public.eclipse_push_tick();' or command like 'select public.eclipse_push_wake(%');
  update public.eclipse_push_config set housekeeping_at=v_now where id=1;
 end if;
 perform public.eclipse_push_plan(clock_timestamp());
end;
$$;

create or replace function public.eclipse_push_wake(p_expected timestamptz)
returns void language plpgsql security definer set search_path='' as $$
declare v_config public.eclipse_push_config%rowtype;
begin
 select * into strict v_config from public.eclipse_push_config where id=1 for update;
 -- Ignore a callback from a reservation replaced by a shared timer edit.
 if p_expected is null or v_config.wake_at is distinct from p_expected then return; end if;
 if exists(select 1 from cron.job where jobid=v_config.wake_job_id and jobname='eclipse-boss-wake' and username=current_user)
 then perform cron.unschedule(v_config.wake_job_id); end if;
 update public.eclipse_push_config set wake_at=null,wake_job_id=null where id=1;
 -- A minute-level cron may start before the target second. Plan one short wake
 -- for the remaining seconds; no notification is enqueued before its due time.
 perform public.eclipse_push_tick();
end;
$$;

create or replace function public.eclipse_push_changed()
returns trigger language plpgsql security definer set search_path='' as $$
begin perform public.eclipse_push_tick(); return null; end;
$$;
drop trigger if exists eclipse_push_timer_changed on public.eclipse_timer_state;
create trigger eclipse_push_timer_changed after update of bosses on public.eclipse_timer_state
for each row when(old.bosses is distinct from new.bosses) execute function public.eclipse_push_changed();
drop trigger if exists eclipse_push_devices_changed on public.eclipse_push_subscriptions;
create trigger eclipse_push_devices_changed after insert or delete on public.eclipse_push_subscriptions
for each statement execute function public.eclipse_push_changed();

revoke all on function public.eclipse_push_plan(timestamptz),public.eclipse_push_tick(),
 public.eclipse_push_wake(timestamptz),public.eclipse_push_changed() from public,anon,authenticated;
grant execute on function public.eclipse_push_tick() to service_role;

-- Replaces the old once-per-minute check. The wake job handles actual deadlines.
select cron.schedule('eclipse-boss-push','0 * * * *','select public.eclipse_push_tick();');
update public.eclipse_push_config set schedule_mode='reserved' where id=1;
select public.eclipse_push_tick();
commit;
