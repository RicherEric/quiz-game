# 互動問答遊戲 (Quiz Game) 資料庫結構

本專案使用 Supabase (PostgreSQL) 作為資料庫，包含以下四個主要資料表：

## 1. `questions` (題庫表)
儲存所有問答題目的內容、選項與計分設定。

| 欄位名稱 | 資料型別 | 屬性 / 說明 |
| :--- | :--- | :--- |
| `id` | `int4` | Primary Key (主鍵) |
| `question` | `text` | 題目內容 |
| `option_a` | `text` | 選項 A |
| `option_b` | `text` | 選項 B |
| `option_c` | `text` | 選項 C |
| `option_d` | `text` | 選項 D |
| `answer` | `int4` | 正確答案 (對應 1-4) |
| `points` | `int4` | 該題基礎分數 |
| `seconds` | `int4` | 該題作答限制秒數 |

## 2. `players` (玩家表)
儲存參賽玩家的資料與目前累積的總分。

| 欄位名稱 | 資料型別 | 屬性 / 說明 |
| :--- | :--- | :--- |
| `id` | `int4` | Primary Key (主鍵) |
| `name` | `text` | 玩家暱稱 (具備唯一性 Unique) |
| `score` | `int4` | 累積總分 (預設為 0) |

## 3. `game_status` (遊戲狀態表)
用於同步所有玩家畫面與目前題目的全域狀態控制表 (Realtime)。

| 欄位名稱 | 資料型別 | 屬性 / 說明 |
| :--- | :--- | :--- |
| `id` | `int4` | Primary Key (主鍵) |
| `current_q_id` | `int4` | 目前進行中的題目 ID |
| `start_time` | `int8` | 題目開始的 UNIX 時間戳 (毫秒) |
| `state` | `text` | 目前遊戲狀態 (例如: waiting, playing, ended) |

## 4. `responses` (作答紀錄表)
紀錄每位玩家在每一題的詳細作答狀況、耗時與對錯。

| 欄位名稱 | 資料型別 | 屬性 / 說明 |
| :--- | :--- | :--- |
| `id` | `int4` | Primary Key (主鍵) |
| `player_name` | `text` | 作答玩家的暱稱 |
| `question_id` | `int4` | 題目的 ID |
| `choice` | `int4` | 玩家選擇的選項 (0 代表逾時, 1-4 代表選項) |
| `is_correct` | `bool` | 是否答對 (true/false) |
| `response_time_ms` | `int4` | 作答耗時 (毫秒) |
| `created_at` | `timestamptz` | 作答建立時間 (預設為 now()) |