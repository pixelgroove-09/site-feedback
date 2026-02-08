-- ============================================
-- 002_rls_policies.sql
-- Row Level Security policies for all tables.
-- Applied via Supabase MCP.
-- ============================================

-- PROFILES: anyone logged in can read, users update own only
create policy "Authenticated users can read all profiles"
  on public.profiles for select to authenticated using (true);

create policy "Users can update own profile"
  on public.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

-- COMMENTS: read all, create own, author updates own, admin updates any
create policy "Authenticated users can read all comments"
  on public.comments for select to authenticated using (true);

create policy "Authenticated users can create comments"
  on public.comments for insert to authenticated
  with check (author_id = auth.uid());

create policy "Author can update own comment"
  on public.comments for update to authenticated
  using (author_id = auth.uid()) with check (author_id = auth.uid());

create policy "Admin can update comment status"
  on public.comments for update to authenticated
  using (
    exists (
      select 1 from public.profiles
      where profiles.id = auth.uid() and profiles.role = 'admin'
    )
  );

-- REPLIES: read all, create own, no edits or deletes
create policy "Authenticated users can read all replies"
  on public.replies for select to authenticated using (true);

create policy "Authenticated users can create replies"
  on public.replies for insert to authenticated
  with check (author_id = auth.uid());
