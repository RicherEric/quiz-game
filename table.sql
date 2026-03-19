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

  IF EXISTS (SELECT 1 FROM players WHERE name = player_name) THEN
    RAISE EXCEPTION '此暱稱已存在，請換一個暱稱再試！';
  END IF;

  INSERT INTO players (name) VALUES (player_name);

  RETURN json_build_object('success', true);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 提交答案（以 QR token 驗證）
CREATE OR REPLACE FUNCTION submit_response(
  p_player_name text,
  p_question_id int,
  p_choice int,
  p_response_time_ms int,
  p_qr_token text DEFAULT NULL
)
RETURNS json AS $$
BEGIN
  IF p_qr_token IS NULL OR NOT EXISTS (SELECT 1 FROM qr_tokens WHERE token = p_qr_token) THEN
    RAISE EXCEPTION 'Not a verified player';
  END IF;

  INSERT INTO responses (player_name, question_id, choice, is_correct, response_time_ms)
  VALUES (p_player_name, p_question_id, p_choice, null, p_response_time_ms)
  ON CONFLICT (player_name, question_id) DO NOTHING;

  RETURN json_build_object('success', true);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 成績結算（SQL 批次計算取代前端逐筆更新）
-- 回傳 correct_count + 所有玩家分數 map，admin 不需額外查詢
CREATE OR REPLACE FUNCTION score_question(
  p_question_id int,
  p_correct_answer int,
  p_mode text DEFAULT 'official'
)
RETURNS json AS $$
DECLARE
  v_points int;
  v_correct_count int;
  v_orig_answer int;
  v_scores json;
BEGIN
  -- 取得該題分數
  SELECT COALESCE(points, 1000), answer
    INTO v_points, v_orig_answer
    FROM questions WHERE id = p_question_id;

  -- 批次更新 responses: is_correct + scored_points
  UPDATE responses
  SET is_correct    = (choice = p_correct_answer AND choice != 0),
      scored_points = CASE
        WHEN (choice = p_correct_answer AND choice != 0)
        THEN FLOOR(v_points * (1 + GREATEST(0, 15000 - COALESCE(response_time_ms, 15000)) / 15000.0 * 0.75) + 0.5)::int
        ELSE 0
      END
  WHERE question_id = p_question_id;

  -- 批次更新 players 分數
  IF p_mode = 'test' THEN
    UPDATE players p
    SET test_score = test_score + r.scored_points
    FROM responses r
    WHERE r.question_id = p_question_id
      AND r.player_name = p.name
      AND r.scored_points > 0;
  ELSE
    UPDATE players p
    SET score = score + r.scored_points
    FROM responses r
    WHERE r.question_id = p_question_id
      AND r.player_name = p.name
      AND r.scored_points > 0;
  END IF;

  -- 統計答對人數
  SELECT COUNT(*) INTO v_correct_count
    FROM responses
   WHERE question_id = p_question_id AND is_correct = true;

  -- 若答案不同，同步更新題庫
  IF v_orig_answer IS DISTINCT FROM p_correct_answer THEN
    UPDATE questions SET answer = p_correct_answer WHERE id = p_question_id;
  END IF;

  -- 建構所有作答玩家的分數 map（取代 admin 端 2 次額外查詢）
  SELECT COALESCE(json_object_agg(
    r.player_name,
    json_build_object(
      'question_score', r.scored_points,
      'total_score', CASE WHEN p_mode = 'test' THEN p.test_score ELSE p.score END
    )
  ), '{}'::json) INTO v_scores
  FROM responses r
  JOIN players p ON p.name = r.player_name
  WHERE r.question_id = p_question_id;

  RETURN json_build_object('correct_count', v_correct_count, 'scores', v_scores);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 玩家統計（答對數 + 平均答題時間）— 供排行榜 & PDF 匯出使用
CREATE OR REPLACE FUNCTION get_player_stats()
RETURNS TABLE(player_name text, correct_count bigint, avg_time_ms numeric) AS $$
  SELECT
    player_name,
    COUNT(*) FILTER (WHERE is_correct = true),
    AVG(response_time_ms) FILTER (WHERE response_time_ms > 0)
  FROM responses
  GROUP BY player_name;
$$ LANGUAGE sql SECURITY DEFINER;

-- 玩家取得自己的本題分數 + 累計分數（單次 JOIN 查詢，SQL 語言可被 planner inline）
CREATE OR REPLACE FUNCTION get_my_score(
  p_player_name text,
  p_question_id int,
  p_mode text DEFAULT 'official'
)
RETURNS json AS $$
  SELECT json_build_object(
    'question_score', COALESCE(r.scored_points, 0),
    'total_score',    CASE WHEN p_mode = 'test'
                           THEN COALESCE(p.test_score, 0)
                           ELSE COALESCE(p.score, 0)
                      END
  )
  FROM players p
  LEFT JOIN responses r
    ON r.player_name = p.name AND r.question_id = p_question_id
  WHERE p.name = p_player_name
  LIMIT 1;
$$ LANGUAGE sql STABLE SECURITY DEFINER;

-- 重置某題作答紀錄（回退分數 + 刪除 responses，取代 O(N) 個別查詢）
CREATE OR REPLACE FUNCTION reset_question_responses(
  p_question_id int, p_mode text DEFAULT 'official'
) RETURNS json AS $$
DECLARE v_deleted int;
BEGIN
  IF p_mode = 'test' THEN
    UPDATE players p SET test_score = GREATEST(0, test_score - sub.pts)
    FROM (SELECT player_name, SUM(scored_points) AS pts FROM responses
          WHERE question_id = p_question_id AND scored_points > 0 GROUP BY player_name) sub
    WHERE p.name = sub.player_name;
  ELSE
    UPDATE players p SET score = GREATEST(0, score - sub.pts)
    FROM (SELECT player_name, SUM(scored_points) AS pts FROM responses
          WHERE question_id = p_question_id AND scored_points > 0 GROUP BY player_name) sub
    WHERE p.name = sub.player_name;
  END IF;
  DELETE FROM responses WHERE question_id = p_question_id;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN json_build_object('deleted', v_deleted);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 取得各選項作答人數（取代 client-side 全表掃描）
CREATE OR REPLACE FUNCTION get_response_counts(p_question_id int)
RETURNS json AS $$
  SELECT COALESCE(json_object_agg(choice, cnt), '{}'::json)
  FROM (
    SELECT choice, COUNT(*) AS cnt
    FROM responses WHERE question_id = p_question_id GROUP BY choice
  ) sub;
$$ LANGUAGE sql SECURITY DEFINER;

-- ============================================================
-- RLS 政策（允許匿名用戶透過 RPC 操作）
-- ============================================================

ALTER TABLE public.qr_tokens ENABLE ROW LEVEL SECURITY;
-- qr_tokens: 允許所有人讀取，允許寫入
DROP POLICY IF EXISTS "Allow anon read qr_tokens" ON public.qr_tokens;
CREATE POLICY "Allow anon read qr_tokens" ON public.qr_tokens FOR SELECT USING (true);
DROP POLICY IF EXISTS "Allow anon all qr_tokens" ON public.qr_tokens;
CREATE POLICY "Allow anon all qr_tokens" ON public.qr_tokens FOR ALL USING (true) WITH CHECK (true);

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

-- questions: 答案註記
ALTER TABLE public.questions ADD COLUMN IF NOT EXISTS answer_note text;

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

-- ============================================================
-- 效能索引（加速 score_question、fetchMyScore、leaderboard 查詢）
-- ============================================================
-- 舊的普通索引由下方 UNIQUE INDEX 取代（同欄位，unique 可兼任查詢加速）
DROP INDEX IF EXISTS idx_responses_player_question;

CREATE INDEX IF NOT EXISTS idx_responses_question_id ON public.responses(question_id);
CREATE INDEX IF NOT EXISTS idx_players_score_desc ON public.players(score DESC);
CREATE INDEX IF NOT EXISTS idx_players_test_score_desc ON public.players(test_score DESC);

-- qr_tokens.token 索引：submit_response 每次都 SELECT 1 FROM qr_tokens WHERE token = ?
-- 沒有索引 = full table scan × 100 人同時提交 = 前幾題延遲 10s+
CREATE UNIQUE INDEX IF NOT EXISTS idx_qr_tokens_token ON public.qr_tokens(token);

-- 清除既有重複 responses（保留最早的一筆，刪除後來的重複）
DELETE FROM public.responses
WHERE id NOT IN (
  SELECT MIN(id) FROM public.responses GROUP BY player_name, question_id
);

-- responses 唯一約束：防止高延遲時玩家重試造成重複 response
-- 同時取代原 idx_responses_player_question，兼作 get_my_score / 重複偵測的查詢索引
CREATE UNIQUE INDEX IF NOT EXISTS idx_responses_unique_player_question
  ON public.responses(player_name, question_id);

-- ============================================================
-- 效能調優：Autovacuum + FILLFACTOR（減少 score_question 後的 vacuum 風暴）
-- ============================================================

-- responses 表在每題結算時做大量 UPDATE，需要更頻繁的小批量 vacuum
-- 預設 scale_factor=0.2 表示 20% 的行變動才觸發，對高頻 UPDATE 太慢
ALTER TABLE public.responses SET (
  autovacuum_vacuum_scale_factor = 0.01,
  autovacuum_vacuum_threshold = 50,
  autovacuum_analyze_scale_factor = 0.01,
  autovacuum_analyze_threshold = 50
);

-- FILLFACTOR 80%：每頁保留 20% 空間給 HOT (Heap-Only Tuple) 更新
-- HOT 更新不需要修改索引，大幅減少 score_question UPDATE 的 I/O
ALTER TABLE public.responses SET (fillfactor = 80);

-- players 表在結算時也會被批次 UPDATE
ALTER TABLE public.players SET (
  autovacuum_vacuum_scale_factor = 0.02,
  autovacuum_vacuum_threshold = 20,
  fillfactor = 90
);

-- 插入 QR token（若不存在）
INSERT INTO public.qr_tokens (id, token)
VALUES (1, 'qz-w10-8f3a2b1c4d5e6f7a')
ON CONFLICT (id) DO NOTHING;


