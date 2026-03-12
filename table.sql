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
  sort_order integer NOT NULL DEFAULT 0,
  image_url text,
  video_url text,
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
CREATE TABLE IF NOT EXISTS public.lottery_groups (
  id integer GENERATED ALWAYS AS IDENTITY NOT NULL,
  name text NOT NULL,
  probability_pct integer NOT NULL DEFAULT 0,
  created_at timestamp with time zone DEFAULT now(),
  CONSTRAINT lottery_groups_pkey PRIMARY KEY (id),
  CONSTRAINT lottery_groups_prob_check CHECK (probability_pct >= 0 AND probability_pct <= 100)
);

-- 抽獎成員
CREATE TABLE IF NOT EXISTS public.lottery_members (
  id integer GENERATED ALWAYS AS IDENTITY NOT NULL,
  name text NOT NULL,
  group_id integer NOT NULL,
  created_at timestamp with time zone DEFAULT now(),
  CONSTRAINT lottery_members_pkey PRIMARY KEY (id),
  CONSTRAINT lottery_members_group_fk FOREIGN KEY (group_id) REFERENCES public.lottery_groups(id) ON DELETE CASCADE
);

-- 獎項
CREATE TABLE IF NOT EXISTS public.lottery_prizes (
  id integer GENERATED ALWAYS AS IDENTITY NOT NULL,
  name text NOT NULL,
  winner_count integer NOT NULL DEFAULT 1,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamp with time zone DEFAULT now(),
  CONSTRAINT lottery_prizes_pkey PRIMARY KEY (id)
);

-- 中獎紀錄
CREATE TABLE IF NOT EXISTS public.lottery_winners (
  id integer GENERATED ALWAYS AS IDENTITY NOT NULL,
  member_id integer NOT NULL,
  prize_id integer NOT NULL,
  drawn_at timestamp with time zone DEFAULT now(),
  CONSTRAINT lottery_winners_pkey PRIMARY KEY (id),
  CONSTRAINT lottery_winners_member_fk FOREIGN KEY (member_id) REFERENCES public.lottery_members(id) ON DELETE CASCADE,
  CONSTRAINT lottery_winners_prize_fk FOREIGN KEY (prize_id) REFERENCES public.lottery_prizes(id) ON DELETE CASCADE
);

-- ============================================================
-- QR Code 驗證相關
-- ============================================================

-- QR token 資料表
CREATE TABLE IF NOT EXISTS public.qr_tokens (
  id integer NOT NULL,
  token text NOT NULL,
  CONSTRAINT qr_tokens_pkey PRIMARY KEY (id)
);

-- 已驗證玩家
CREATE TABLE IF NOT EXISTS public.verified_players (
  user_id uuid NOT NULL,
  CONSTRAINT verified_players_pkey PRIMARY KEY (user_id)
);

-- ============================================================
-- RPC 函數
-- ============================================================

-- 加入遊戲（驗證 QR token）
CREATE OR REPLACE FUNCTION join_via_qr(qr_token text, player_name text)
RETURNS json AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM qr_tokens WHERE token = qr_token) THEN
    RAISE EXCEPTION 'Invalid QR token';
  END IF;

  INSERT INTO verified_players (user_id)
  VALUES (auth.uid())
  ON CONFLICT (user_id) DO NOTHING;

  IF EXISTS (SELECT 1 FROM players WHERE name = player_name) THEN
    RAISE EXCEPTION '此暱稱已存在，請換一個暱稱再試！';
  END IF;

  INSERT INTO players (name) VALUES (player_name);

  RETURN json_build_object('success', true);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 提交答案（驗證玩家身份）
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

  INSERT INTO responses (player_name, question_id, choice, is_correct, response_time_ms)
  VALUES (p_player_name, p_question_id, p_choice, null, p_response_time_ms);

  RETURN json_build_object('success', true);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================
-- RLS 政策（允許匿名用戶透過 RPC 操作）
-- ============================================================

ALTER TABLE public.qr_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.verified_players ENABLE ROW LEVEL SECURITY;

-- qr_tokens: 允許所有人讀取，允許寫入
DROP POLICY IF EXISTS "Allow anon read qr_tokens" ON public.qr_tokens;
CREATE POLICY "Allow anon read qr_tokens" ON public.qr_tokens FOR SELECT USING (true);
DROP POLICY IF EXISTS "Allow anon all qr_tokens" ON public.qr_tokens;
CREATE POLICY "Allow anon all qr_tokens" ON public.qr_tokens FOR ALL USING (true) WITH CHECK (true);

-- verified_players: 透過 SECURITY DEFINER 函數操作，不需額外 policy

-- ============================================================
-- 初始資料
-- ============================================================

ALTER TABLE public.questions ADD COLUMN IF NOT EXISTS sort_order integer NOT NULL DEFAULT 0;
  -- Backfill existing rows with sequential sort_order based on current id order
  WITH ordered AS (
    SELECT id, ROW_NUMBER() OVER (ORDER BY id) - 1 AS new_order
    FROM public.questions
  )
  UPDATE public.questions q SET sort_order = o.new_order
  FROM ordered o WHERE q.id = o.id;


ALTER TABLE public.responses ADD COLUMN IF NOT EXISTS scored_points integer NOT NULL DEFAULT 0;

-- lottery_winners: 備註欄位、群組抽獎支援
ALTER TABLE public.lottery_winners ADD COLUMN IF NOT EXISTS note text;
ALTER TABLE public.lottery_winners ADD COLUMN IF NOT EXISTS group_id integer REFERENCES public.lottery_groups(id) ON DELETE CASCADE;
ALTER TABLE public.lottery_winners ALTER COLUMN member_id DROP NOT NULL;

-- ============================================================
-- Storage bucket RLS 政策（question-media）
-- ============================================================

-- 建立 storage bucket（若不存在）
INSERT INTO storage.buckets (id, name, public)
VALUES ('question-media', 'question-media', true)
ON CONFLICT (id) DO NOTHING;

-- 允許所有人讀取（公開檢視圖片/影片）
DROP POLICY IF EXISTS "Allow public read question-media" ON storage.objects;
CREATE POLICY "Allow public read question-media" ON storage.objects
  FOR SELECT USING (bucket_id = 'question-media');

-- 允許所有人上傳（管理後台使用 anon key）
DROP POLICY IF EXISTS "Allow public insert question-media" ON storage.objects;
CREATE POLICY "Allow public insert question-media" ON storage.objects
  FOR INSERT WITH CHECK (bucket_id = 'question-media');

-- 允許所有人更新
DROP POLICY IF EXISTS "Allow public update question-media" ON storage.objects;
CREATE POLICY "Allow public update question-media" ON storage.objects
  FOR UPDATE USING (bucket_id = 'question-media');

-- 允許所有人刪除（管理後台刪除舊媒體）
DROP POLICY IF EXISTS "Allow public delete question-media" ON storage.objects;
CREATE POLICY "Allow public delete question-media" ON storage.objects
  FOR DELETE USING (bucket_id = 'question-media');

-- 答案媒體欄位
ALTER TABLE public.questions ADD COLUMN IF NOT EXISTS answer_image_url text;
ALTER TABLE public.questions ADD COLUMN IF NOT EXISTS answer_video_url text;

-- 多媒體陣列欄位（支援多張圖片/多個影片）
ALTER TABLE public.questions ADD COLUMN IF NOT EXISTS image_urls jsonb DEFAULT '[]';
ALTER TABLE public.questions ADD COLUMN IF NOT EXISTS video_urls jsonb DEFAULT '[]';
ALTER TABLE public.questions ADD COLUMN IF NOT EXISTS answer_image_urls jsonb DEFAULT '[]';
ALTER TABLE public.questions ADD COLUMN IF NOT EXISTS answer_video_urls jsonb DEFAULT '[]';

-- 遷移舊資料到新欄位
UPDATE public.questions SET image_urls = jsonb_build_array(image_url) WHERE image_url IS NOT NULL AND image_url != '' AND (image_urls = '[]'::jsonb);
UPDATE public.questions SET video_urls = jsonb_build_array(video_url) WHERE video_url IS NOT NULL AND video_url != '' AND (video_urls = '[]'::jsonb);
UPDATE public.questions SET answer_image_urls = jsonb_build_array(answer_image_url) WHERE answer_image_url IS NOT NULL AND answer_image_url != '' AND (answer_image_urls = '[]'::jsonb);
UPDATE public.questions SET answer_video_urls = jsonb_build_array(answer_video_url) WHERE answer_video_url IS NOT NULL AND answer_video_url != '' AND (answer_video_urls = '[]'::jsonb);

-- 題目類型（正式/測試）
ALTER TABLE public.questions ADD COLUMN IF NOT EXISTS type text NOT NULL DEFAULT 'official';
-- 遊戲模式（正式/測試），讓玩家端知道目前模式
ALTER TABLE public.game_status ADD COLUMN IF NOT EXISTS mode text NOT NULL DEFAULT 'official';
-- 測試分數獨立累計
ALTER TABLE public.players ADD COLUMN IF NOT EXISTS test_score integer DEFAULT 0;

-- 插入 QR token（若不存在）
INSERT INTO public.qr_tokens (id, token)
VALUES (1, 'qz-w10-8f3a2b1c4d5e6f7a')
ON CONFLICT (id) DO NOTHING;


