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

CREATE TABLE IF NOT EXISTS public.qr_tokens (
  id serial PRIMARY KEY,
  token text UNIQUE NOT NULL,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.verified_players (
  user_id uuid PRIMARY KEY,
  verified_at timestamptz DEFAULT now()
);

-- 2. 新增欄位（若不存在）
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'players' AND column_name = 'user_id'
  ) THEN
    ALTER TABLE public.players ADD COLUMN user_id uuid;
  END IF;
END $$;

-- 3. RPC 函數（CREATE OR REPLACE 天生冪等）

CREATE OR REPLACE FUNCTION join_via_qr(qr_token text, player_name text)
RETURNS json AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM qr_tokens WHERE token = qr_token) THEN
    RAISE EXCEPTION 'Invalid QR token';
  END IF;

  INSERT INTO verified_players (user_id)
  VALUES (auth.uid())
  ON CONFLICT (user_id) DO NOTHING;

  INSERT INTO players (name, user_id)
  VALUES (player_name, auth.uid());

  RETURN json_build_object('success', true);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION submit_response(
  p_player_name text,
  p_question_id int,
  p_choice int,
  p_response_time_ms int
)
RETURNS json AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM verified_players WHERE user_id = auth.uid()) THEN
    RAISE EXCEPTION 'Not a verified player';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM players WHERE name = p_player_name AND user_id = auth.uid()) THEN
    RAISE EXCEPTION 'Player name mismatch';
  END IF;

  INSERT INTO responses (player_name, question_id, choice, is_correct, response_time_ms)
  VALUES (p_player_name, p_question_id, p_choice, null, p_response_time_ms);

  RETURN json_build_object('success', true);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 管理員登入驗證（透過 RPC，不需要開放 users 表的 RLS）
CREATE OR REPLACE FUNCTION admin_login(p_username text, p_password text)
RETURNS json AS $$
DECLARE
  v_id integer;
BEGIN
  SELECT id INTO v_id FROM users
  WHERE username = p_username AND password = p_password;

  IF v_id IS NULL THEN
    RETURN json_build_object('success', false);
  END IF;

  RETURN json_build_object('success', true, 'user_id', v_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 4. 啟用 RLS（重複執行不會報錯）
ALTER TABLE public.players ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.responses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.game_status ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.questions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.qr_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.verified_players ENABLE ROW LEVEL SECURITY;

-- 5. RLS 政策（先 DROP 再 CREATE，確保冪等）
DROP POLICY IF EXISTS "verified_read_players" ON public.players;
CREATE POLICY "verified_read_players" ON public.players
  FOR SELECT USING (
    auth.uid() IN (SELECT user_id FROM verified_players)
  );

DROP POLICY IF EXISTS "verified_read_responses" ON public.responses;
CREATE POLICY "verified_read_responses" ON public.responses
  FOR SELECT USING (
    auth.uid() IN (SELECT user_id FROM verified_players)
  );

DROP POLICY IF EXISTS "anyone_read_game_status" ON public.game_status;
CREATE POLICY "anyone_read_game_status" ON public.game_status
  FOR SELECT USING (true);

DROP POLICY IF EXISTS "verified_read_questions" ON public.questions;
CREATE POLICY "verified_read_questions" ON public.questions
  FOR SELECT USING (
    auth.uid() IN (SELECT user_id FROM verified_players)
  );

-- qr_tokens: 不開放直接讀取（透過 RPC 驗證）
-- verified_players: 不開放直接讀取
