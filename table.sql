-- ============================================================
-- Idempotent migration: 可重複執行，不會報錯
-- ============================================================

-- 1. 建立資料表（若不存在）
CREATE TABLE IF NOT EXISTS public.game_status (
  id integer NOT NULL,
  current_q_id integer,
  state text,
  start_time bigint,
  CONSTRAINT game_status_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public.players (
  id integer GENERATED ALWAYS AS IDENTITY NOT NULL,
  name text UNIQUE,
  score integer DEFAULT 0,
  CONSTRAINT players_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public.questions (
  id integer GENERATED ALWAYS AS IDENTITY NOT NULL,
  question text,
  option_a text,
  option_b text,
  option_c text,
  option_d text,
  answer integer,
  points integer DEFAULT 1000,
  seconds integer DEFAULT 20,
  CONSTRAINT questions_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public.responses (
  id integer GENERATED ALWAYS AS IDENTITY NOT NULL,
  player_name text,
  question_id integer,
  choice integer,
  is_correct boolean,
  response_time_ms integer,
  created_at timestamp with time zone DEFAULT now(),
  CONSTRAINT responses_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public.users (
  id integer GENERATED ALWAYS AS IDENTITY NOT NULL,
  username text NOT NULL UNIQUE,
  password text NOT NULL,
  created_at timestamp with time zone DEFAULT now(),
  CONSTRAINT users_pkey PRIMARY KEY (id)
);

-- 抽獎群組
CREATE TABLE public.lottery_groups (
  id integer GENERATED ALWAYS AS IDENTITY NOT NULL,
  name text NOT NULL,
  probability_pct integer NOT NULL DEFAULT 0,
  created_at timestamp with time zone DEFAULT now(),
  CONSTRAINT lottery_groups_pkey PRIMARY KEY (id),
  CONSTRAINT lottery_groups_prob_check CHECK (probability_pct >= 0 AND probability_pct <= 100)
);

-- 抽獎成員
CREATE TABLE public.lottery_members (
  id integer GENERATED ALWAYS AS IDENTITY NOT NULL,
  name text NOT NULL,
  group_id integer NOT NULL,
  created_at timestamp with time zone DEFAULT now(),
  CONSTRAINT lottery_members_pkey PRIMARY KEY (id),
  CONSTRAINT lottery_members_group_fk FOREIGN KEY (group_id) REFERENCES public.lottery_groups(id) ON DELETE CASCADE
);

-- 獎項
CREATE TABLE public.lottery_prizes (
  id integer GENERATED ALWAYS AS IDENTITY NOT NULL,
  name text NOT NULL,
  winner_count integer NOT NULL DEFAULT 1,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamp with time zone DEFAULT now(),
  CONSTRAINT lottery_prizes_pkey PRIMARY KEY (id)
);

-- 中獎紀錄
CREATE TABLE public.lottery_winners (
  id integer GENERATED ALWAYS AS IDENTITY NOT NULL,
  member_id integer NOT NULL,
  prize_id integer NOT NULL,
  drawn_at timestamp with time zone DEFAULT now(),
  CONSTRAINT lottery_winners_pkey PRIMARY KEY (id),
  CONSTRAINT lottery_winners_member_fk FOREIGN KEY (member_id) REFERENCES public.lottery_members(id) ON DELETE CASCADE,
  CONSTRAINT lottery_winners_prize_fk FOREIGN KEY (prize_id) REFERENCES public.lottery_prizes(id) ON DELETE CASCADE
);