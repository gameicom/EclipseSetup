-- Filled in browser memory by the web setup page; do not add actual secrets to Git.
begin;
create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;
create extension if not exists supabase_vault with schema vault;
do $$
declare v_id uuid;
begin
 select id into v_id from vault.secrets where name='eclipse_push_dispatch';
 if v_id is null then
  perform vault.create_secret('__PUSH_SECRET__','eclipse_push_dispatch');
 else
  perform vault.update_secret(v_id,'__PUSH_SECRET__','eclipse_push_dispatch');
 end if;
end $$;
create or replace function public.eclipse_push_tick()
returns void language plpgsql security definer set search_path='' as $$
declare v_secret text;
begin
 if not exists(select 1 from public.eclipse_push_config where id=1 and enabled) then return; end if;
 perform public.eclipse_push_enqueue();
 if exists(select 1 from public.eclipse_push_jobs where sent_at is null and attempts<3
  and due_at>clock_timestamp()-interval '5 minutes'
  and (leased_until is null or leased_until<clock_timestamp())) then
  select decrypted_secret into strict v_secret from vault.decrypted_secrets where name='eclipse_push_dispatch';
  perform net.http_post(url:='__FUNCTION_URL__',
   headers:=jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||v_secret),
   body:='{}'::jsonb,timeout_milliseconds:=50000);
 end if;
end;
$$;
revoke all on function public.eclipse_push_tick() from public,anon,authenticated;
grant execute on function public.eclipse_push_tick() to service_role;
select cron.schedule('eclipse-boss-push','* * * * *','select public.eclipse_push_tick();');
update public.eclipse_push_config set enabled=true,last_checked=clock_timestamp() where id=1;
commit;
