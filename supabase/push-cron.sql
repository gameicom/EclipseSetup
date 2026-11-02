-- Filled in browser memory for first-time setup; do not add actual secrets to Git.
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
update public.eclipse_push_config set enabled=true,last_checked=clock_timestamp(),
 function_url='__FUNCTION_URL__' where id=1;
-- The scheduler definitions follow in the generated setup SQL.
commit;
