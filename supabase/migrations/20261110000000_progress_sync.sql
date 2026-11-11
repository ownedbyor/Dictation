-- Progress sync: one JSON record per personal code.
create table public.progress (
  code text primary key check (char_length(code) between 6 and 64),
  data jsonb not null default '{}'::jsonb check (pg_column_size(data) < 200000),
  updated_at timestamptz not null default now()
);

-- RLS on with no policies: the browser key cannot read, list or write the table directly.
alter table public.progress enable row level security;
revoke all on public.progress from anon, authenticated;

-- Access only through these two functions, and only for a code the caller already knows.
create or replace function public.get_progress(p_code text)
returns jsonb language sql stable security definer set search_path = '' as $$
  select data from public.progress where code = lower(trim(p_code));
$$;

create or replace function public.save_progress(p_code text, p_data jsonb)
returns timestamptz language plpgsql security definer set search_path = '' as $$
declare
  v_code text := lower(trim(p_code));
  v_now timestamptz := now();
begin
  if char_length(v_code) < 6 or char_length(v_code) > 64 then
    raise exception 'invalid code';
  end if;
  insert into public.progress (code, data, updated_at)
  values (v_code, p_data, v_now)
  on conflict (code) do update set data = excluded.data, updated_at = v_now;
  return v_now;
end;
$$;

revoke all on function public.get_progress(text) from public;
revoke all on function public.save_progress(text, jsonb) from public;
grant execute on function public.get_progress(text) to anon, authenticated;
grant execute on function public.save_progress(text, jsonb) to anon, authenticated;
