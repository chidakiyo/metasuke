-- プロフィール: auth.users のメール変更を profiles.email に同期
-- （新規作成は 0003 の on_auth_user_created で対応済み。本トリガは「変更」を追従）

create or replace function public.sync_profile_email()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  update public.profiles set email = new.email where user_id = new.id;
  return new;
end;
$$;

create trigger on_auth_user_email_updated
after update of email on auth.users
for each row when (new.email is distinct from old.email)
execute function public.sync_profile_email();
