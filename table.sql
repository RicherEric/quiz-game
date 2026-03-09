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