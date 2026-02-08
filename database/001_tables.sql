-- ============================================
-- 001_tables.sql
-- Creates the three main tables for the site feedback tool.
-- Applied via Supabase MCP.
-- ============================================

-- PROFILES TABLE
-- Stores user display info and role.
-- Auto-populated by a trigger (see 003_triggers.sql).
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  display_name text,
  role text not null default 'reviewer' check (role in ('admin', 'reviewer')),
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

-- COMMENTS TABLE
-- Each comment is a pin placed on a specific page.
create table public.comments (
  id uuid primary key default gen_random_uuid(),
  page_url text not null,
  page_title text,
  x_percent real not null,
  y_offset real not null,
  selector text,
  comment_text text not null,
  author_id uuid not null references public.profiles(id),
  status text not null default 'open' check (status in ('open', 'resolved')),
  resolved_by uuid references public.profiles(id),
  resolved_at timestamptz,
  created_at timestamptz not null default now()
);

alter table public.comments enable row level security;
create index idx_comments_page_url on public.comments(page_url);

-- REPLIES TABLE
-- Each reply belongs to a comment thread.
create table public.replies (
  id uuid primary key default gen_random_uuid(),
  comment_id uuid not null references public.comments(id) on delete cascade,
  reply_text text not null,
  author_id uuid not null references public.profiles(id),
  created_at timestamptz not null default now()
);

alter table public.replies enable row level security;
create index idx_replies_comment_id on public.replies(comment_id);
