-- KV table for AMKO (same as before)
create table if not exists public.amko_kv (
  key text primary key,
  value jsonb not null default 'null'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.amko_kv enable row level security;

drop policy if exists "kv anon select" on public.amko_kv;
drop policy if exists "kv anon upsert" on public.amko_kv;
drop policy if exists "kv anon update" on public.amko_kv;
drop policy if exists "kv anon delete" on public.amko_kv;

create policy "kv anon select" on public.amko_kv for select using (true);
create policy "kv anon upsert" on public.amko_kv for insert with check (true);
create policy "kv anon update" on public.amko_kv for update using (true);
create policy "kv anon delete" on public.amko_kv for delete using (true);
