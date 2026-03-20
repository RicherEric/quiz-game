# Quiz Game - Claude Code 開發指引

## 專案概述

滙智 10 週年互動問答遊戲平台。支援 100+ 人同時作答，Admin 控制遊戲流程，Player 透過 QR Code 加入。

**Tech Stack**: Vanilla JS + Tailwind CSS + Supabase (PostgreSQL + Realtime + Storage)

## 檔案結構

| 檔案 | 用途 |
|------|------|
| `index.html` | 玩家端 UI（加入、作答、計分、排行榜） |
| `admin.html` | 管理端（遊戲控制、題目管理、排行榜、抽獎、PDF 匯出） |
| `table.sql` | DB schema + RPC 函數 + 索引 + 效能調優（冪等，可重複執行） |
| `js/shared.js` | 共用工具（YouTube 提取、lightbox） |
| `css/shared.css` | 共用樣式（金色漸層、動畫） |
| `e2e-test/quiz-test.mjs` | Quiz E2E 負載測試（100 玩家 + 1 Admin Playwright 自動化） |
| `e2e-test/dice-test.mjs` | 魚蝦蟹 E2E 負載測試（100 玩家 + 1 Admin，3 回合押注流程） |
| `lottery.html` | 抽獎功能 |
| `dice.html` | 魚蝦蟹玩家端（加入房間、押注、開獎、排行榜） |
| `dice-admin.html` | 魚蝦蟹莊家控台（房間管理、擲骰、結算） |

## 遊戲狀態機（嚴格遵守）

```
waiting → playing → stopped → revealed → scoring → waiting (下一題) / ended
```

| 狀態 | Admin 操作 | Player 看到 |
|------|-----------|-------------|
| `waiting` | 選擇題目 | 等待畫面 |
| `playing` | 點「開放作答」→ 倒數計時開始 | 題目 + 4 選項 + 倒數環 |
| `stopped` | 點「停止作答」(或倒數結束) | 鎖定答案 |
| `revealed` | 點「公布答案」 | 顯示正確答案 + 各選項人數 + 答案媒體 |
| `scoring` | 點「結算」→ `score_question` RPC + broadcast | 顯示本題得分 + 累計分數 |
| `waiting` | 點「下一題」 | 回到等待畫面 |
| `ended` | 點「結束遊戲」 | 排行榜 + 前三名 + confetti |
| `dismissed` | 踢出玩家 | 回到登入畫面 |

**重要**：任何修改都不得破壞此狀態流程。新功能必須嵌入既有狀態，不可新增或跳過狀態。

## 效能至上原則

> **所有修改必須以效能為最優先考量。** 這是 100+ 人同時在線的即時互動遊戲，任何效能退化都會導致使用者體驗崩壞。

### 嚴格禁止

- **禁止 N+1 查詢**：不可對每個玩家發一次 DB 請求。必須用批次操作（batch UPDATE/INSERT）
- **禁止用 client-side 迴圈取代 SQL 批次**：分數計算、狀態更新等邏輯必須在 SQL RPC 內完成
- **禁止移除或弱化既有的效能優化**（索引、fillfactor、autovacuum、broadcast channel）
- **禁止把 polling 當主要通訊方式**：Realtime subscription 是主通道，polling 只做 fallback
- **禁止在高頻路徑（submit_response、score_question）加入不必要的 SELECT/JOIN**
- **禁止 blocking I/O 在前端主線程**：所有 DB 操作必須 async，不可卡住 UI

### 既有效能架構（不可退化）

1. **SQL Batch Scoring** (`score_question` RPC)
   - 單一 RPC 完成：UPDATE responses → UPDATE players → COUNT correct → 回傳所有玩家分數 map
   - 取代 admin 端 2+ 次額外查詢
   - 回傳 `{ correct_count, scores: { player_name: { question_score, total_score } } }`

2. **Broadcast Channel（分數派發）**
   - Admin 結算後透過 `score-broadcast` channel 一次推送所有玩家分數
   - Player 端監聽 broadcast → 即時顯示分數（不需個別 RPC）
   - Fallback：broadcast 未收到 → 1 秒後 RPC `get_my_score()`

3. **Realtime + Polling Hybrid**
   - 主通道：Supabase Realtime subscription（`postgres_changes` on `game_status`）
   - Fallback：每 15 秒 polling `game_status`（網路異常時保底）
   - 手動同步按鈕：Player 可主動 re-fetch

4. **DB 層效能調優**
   - `FILLFACTOR 80`（responses）/ `90`（players）：啟用 HOT Update，避免 index rewrite
   - `autovacuum_vacuum_scale_factor = 0.01`：1% dead rows 就觸發 vacuum（預設 20%）
   - 複合索引 `(player_name, question_id)`：加速 `get_my_score`、重複偵測
   - 降序索引 `score DESC` / `test_score DESC`：加速排行榜排序

5. **`get_my_score` 使用 `STABLE` + `SQL` 語言函數**
   - PostgreSQL planner 可 inline 優化
   - 單一 JOIN 查詢，不需子查詢

6. **前端快取**
   - Admin 端 `_playersCache`：2 秒 TTL 避免重複 fetch
   - Player 端 `sessionStorage`：暱稱快取，重新整理自動 rejoin
   - `questionIdOrder`：加入時預取題目順序，避免重複查詢

### 修改時的效能檢查清單

- [ ] 新增的 DB 查詢是否有對應索引？
- [ ] 是否用了批次操作而非逐筆處理？
- [ ] 是否維持 broadcast > RPC > polling 的優先順序？
- [ ] 新增的 RPC 函數是否標記 `STABLE`（唯讀）或 `VOLATILE`（寫入）？
- [ ] 前端是否避免了不必要的重新渲染？
- [ ] e2e test 的 pass/fail 指標是否仍能通過？

## 即時通訊架構（Realtime Communication）

### 三層 Fallback 架構

所有即時通訊遵循 **Broadcast → postgres_changes → Polling** 的優先順序：

| 層級 | 機制 | 延遲 | 用途 |
|------|------|------|------|
| 1 (主) | Broadcast（WebSocket 直推） | ~ms | 遊戲狀態、分數派發、抽獎結果 |
| 2 (備) | postgres_changes（WAL → Realtime） | ~100ms | DB 異動監聽，Broadcast 漏接時接住 |
| 3 (保底) | Polling（HTTP 定時查詢） | 5-15s | 網路異常時最後防線 |

### Channel 總覽

#### 遊戲核心 Channel

| Channel 名稱 | 類型 | 發送端 | 接收端 | 事件 | 用途 |
|--------------|------|--------|--------|------|------|
| `game-state-broadcast` | broadcast | Admin | Player | `state-change` | 遊戲狀態變更推播 |
| `quiz-control` | postgres_changes | DB (UPDATE) | Player | `game_status` 表異動 | 狀態變更 fallback |
| `score-broadcast` | broadcast | Admin | Player | `score-update` | 結算分數一次推送 |

#### Admin 專用 Channel

| Channel 名稱 | 類型 | 監聽表 | 用途 |
|--------------|------|--------|------|
| `admin-realtime` | postgres_changes | `responses` (INSERT) + `players` (*) | 即時更新作答統計、玩家列表、排行榜 |
| `admin-lottery-winners-sync` | postgres_changes | `lottery_winners` | 中獎記錄同步 |
| `admin-lottery-groups-sync` | postgres_changes | `lottery_groups` | 抽獎群組同步 |
| `admin-lottery-members-sync` | postgres_changes | `lottery_members` | 群組成員同步 |
| `admin-lottery-prizes-sync` | postgres_changes | `lottery_prizes` | 獎品同步 |

#### 抽獎 Channel（Player / lottery.html）

| Channel 名稱 | 類型 | 用途 |
|--------------|------|------|
| `lottery-prizes-sync` | postgres_changes | 獎品變更 |
| `lottery-winners-sync` | postgres_changes | 中獎記錄變更 |
| `lottery-groups-sync` | postgres_changes | 群組變更 |
| `lottery-members-sync` | postgres_changes | 成員變更 |
| `lottery-broadcast-sync` | broadcast (`winners-changed`) | 抽獎結果即時推送 |

#### Channel 命名規則

- Broadcast channel：含 `-broadcast` 字樣
- postgres_changes channel：含 `-sync` 字尾
- Admin 專用：加 `admin-` 前綴

### Broadcast Payload 結構

**遊戲狀態推播** (`game-state-broadcast` → `state-change`)：
```javascript
{
  current_q_id: number,
  state: 'waiting' | 'playing' | 'stopped' | 'revealed' | 'scoring' | 'ended' | 'dismissed',
  start_time: number,  // Date.now()，用於 dedup
  current_group_id: number  // 題組 ID
}
```

**分數推播** (`score-broadcast` → `score-update`)：
```javascript
{
  question_id: number,
  scores: {
    [player_name]: { question_score: number, total_score: number }
    // 所有玩家的分數，一次推送
  }
}
```

**抽獎推播** (`lottery-broadcast-sync` → `winners-changed`)：
```javascript
{} // 空 payload，接收端自行 reload
```

### 去重機制（Deduplication）

| 機制 | 位置 | 實作方式 |
|------|------|---------|
| 狀態複合鍵 | `index.html` Player 端 | `lastProcessedKey = "{state}_{current_q_id}_{start_time}"` |
| 抽獎 Hash | `lottery.html` | `getWinnerHash()` 比對前後快照 |
| State Version | `index.html` Player 端 | `stateVersion++` 遞增，async 操作中途若版本不符則中止 |

### Polling 機制

| 位置 | 間隔 | 觸發對象 | 用途 |
|------|------|---------|------|
| Player 端 `checkCurrentStatus()` | 15 秒 | `game_status` 表 | 遊戲狀態保底同步 |
| Admin 端 `fetchCurrentQuestionStats()` | 5 秒 | 作答統計 | 統計數字保底更新 |
| Lottery 端 polling | 5 秒 | winners / prizes / groups | 抽獎資料保底同步 |
| Admin 計時器 | 200ms | 本地時鐘 | 作答經過秒數顯示 |
| Player 倒數計時 | 100ms | 本地時鐘 | 倒數環動畫 + 自動提交 |

### 快取策略

| 快取 | 位置 | TTL / 失效條件 | 用途 |
|------|------|---------------|------|
| `_playersCache` | Admin 端 | 2 秒 TTL；`players` 表異動時清除 | 避免重複 fetch 玩家列表 |
| `questionsMap` | Player 端 | 加入時載入，整場遊戲不變 | 避免 100+ 人同時 fetch 題目 |
| `pendingScore` | Player 端 | broadcast 收到時寫入，scoring 狀態處理後清除 | 暫存分數，等進入 scoring 狀態再用 |
| `sessionStorage` | Player 端 | 瀏覽器關閉前 | 暱稱快取，重新整理自動 rejoin |
| `questionIdOrder` | Player 端 | 加入時預取 | 題目順序快取，避免重複查詢 |

### 重試邏輯（Retry with Exponential Backoff）

`withRetry(fn, maxRetries = 3)` — Player 端所有 DB 操作包裹此函式：

- **偵測暫時性錯誤**：502 / 503 / 504 / Bad Gateway / fetch failed / network error
- **退避策略**：`1000 * 2^attempt + random(0~500)ms`（約 1s → 2s → 4s）
- **非暫時性錯誤**：立即回傳，不重試

### 分數派發流程（Scoring Flow）

```
Admin 按「結算」
  → score_question RPC（Server 端批次計算所有玩家分數）
  → Admin 收到 { scores: { name: { question_score, total_score } } }
  → score-broadcast 一次推送給所有 Player
  → Player 收到 broadcast → 存入 pendingScore
  → 狀態切到 scoring → 從 pendingScore 讀取顯示
  → 若 broadcast 漏接 → 等 1 秒 → RPC get_my_score() fallback
```

### 手動同步按鈕

Player 端提供 `#sync-btn`，點擊後立即呼叫 `checkCurrentStatus()` 強制同步，防止 Realtime 斷線但玩家未感知的情況。

### 重推機制（Re-broadcast）

Admin 端「重新推播」按鈕：
1. 更新 `game_status.start_time`（觸發 postgres_changes fallback）
2. 同時送出 broadcast（觸發主通道）
3. 確保兩條路徑都能讓漏接的玩家收到狀態

### 修改即時通訊時的注意事項

- **不可移除任何現有 channel** — 移除會破壞 fallback 鏈
- **新增 channel 需同時考慮 broadcast + postgres_changes 兩層**
- **broadcast payload 應儘量小** — 100+ 人同時接收，大 payload 浪費頻寬
- **postgres_changes 是 DB 層事件，避免高頻寫入觸發過多事件**
- **Polling 只做保底，間隔不應低於 5 秒**
- **所有 channel 設定 `{ broadcast: { self: false } }`** — 避免自己收到自己的廣播

## 題組系統（Question Groups）

- `question_groups` 表：每個題組有 `id` 和 `name`（預設有 `official`、`test`）
- `game_status.current_group_id` 決定目前使用的題組
- `questions.group_id` FK 指向 `question_groups.id`，篩選題目
- `player_scores(player_name, group_id, score)` 獨立表追蹤每個題組的分數
- **Admin 可以自訂任意數量的題組，不再限於 official/test 兩種**
- **任何涉及分數的操作都必須傳入 `group_id`**
- 舊欄位（`questions.type`、`game_status.mode`、`players.score`、`players.test_score`）保留向下相容但不再使用

## RPC 函數簽名（修改時必須維持相容）

```sql
join_via_qr(qr_token text, player_name text) → json
submit_response(p_player_name, p_question_id, p_choice, p_response_time_ms, p_qr_token) → json
score_question(p_question_id, p_correct_answer, p_group_id int DEFAULT NULL) → json
get_my_score(p_player_name, p_question_id, p_group_id int DEFAULT NULL) → json
get_response_counts(p_question_id) → json
get_player_stats(p_group_id int DEFAULT NULL) → TABLE(player_name, correct_count, avg_time_ms)
reset_question_responses(p_question_id, p_group_id int DEFAULT NULL) → json
```

## 計分公式

```
scored_points = floor(base_points * (1 + max(0, 15000 - response_time_ms) / 15000 * 0.75) + 0.5)
```

- 答對：base_points（預設 1000）+ 最高 75% 時間獎勵（15 秒內）
- 答錯或未答（choice = 0）：0 分

## E2E 測試

### Quiz 測試
```bash
cd e2e-test && node quiz-test.mjs
```
- 12 項 pass/fail 指標（API p95 < 2s、Realtime p95 < 3s、成功率 ≥ 95% 等）
- 6 項資料完整性檢查、9 項邊界條件測試

### 魚蝦蟹 Dice 測試
```bash
cd e2e-test && node dice-test.mjs
```
- 100 玩家同時押注，3 回合完整流程
- 12 項 pass/fail 指標（Bet API p95 < 2s、Resolve RPC p95 < 3s 等）
- 6 項資料完整性檢查、9 項邊界條件測試

### 共通
- 需要 `.env`（`SUPABASE_URL`, `SUPABASE_KEY`, `ADMIN_PASSWORD`）
- 修改後務必確認測試通過

## table.sql 設計原則

- **冪等**：所有語句用 `IF NOT EXISTS` / `ON CONFLICT DO NOTHING`，可重複執行
- **RPC = SECURITY DEFINER**：繞過 RLS，在函數內部做驗證
- **新增欄位用 `ADD COLUMN IF NOT EXISTS`**，不可刪除既有欄位

## 魚蝦蟹骰子遊戲

### 符號對照

| 編號 | 符號 | Emoji |
|------|------|-------|
| 1 | 魚 | 🐟 |
| 2 | 蝦 | 🦐 |
| 3 | 蟹 | 🦀 |
| 4 | 雞 | 🐓 |
| 5 | 葫蘆 | 🍐 |
| 6 | 錢幣 | 🪙 |

### 狀態機

```
waiting → betting → stopped → rolling → resolved → waiting (下一局) / ended
```

| 狀態 | Admin 操作 | Player 看到 |
|------|-----------|-------------|
| `waiting` | 準備開局 | 等待畫面 + 餘額 |
| `betting` | 點「開放押注」→ 倒數開始 | 6 符號押注區 + 籌碼選擇 + 倒數 |
| `stopped` | 點「停止押注」 | 鎖定押注 |
| `rolling` | 擲骰（隨機或手動） | 骰子動畫 |
| `resolved` | 系統結算 + 廣播 | 結果 + 輸贏 + 餘額 |
| `ended` | 結束遊戲 | 排行榜 |

### 獨立架構

- **獨立 QR Code**：每個 `dice_rooms` 有自己的 `qr_token`，玩家掃碼進 `dice.html?token=XXX`
- **獨立玩家系統**：`dice_players` 表，不共用 `players` 表
- **獨立房間**：`dice_rooms` 表（不複用 `question_groups`）
- **獨立狀態**：`dice_game_status` 表（不影響 `game_status`）

### 賠率

- **單面押注**（single）：出現 1 次 → 1:1、2 次 → 1:2、3 次 → 1:3
- **圍骰通殺**：`house_wins_on_triple=true` 時，三顆一樣所有 single 押注歸莊
- **指定圍骰**（triple）：三顆一樣且符合指定符號 → 1:N（N=triple_payout，預設 150）
- **全圍**（any_triple）：三顆一樣任何符號 → 1:N（N=any_triple_payout，預設 24）

### RPC 函數

```sql
dice_join_room(p_token, p_player_name) → json
dice_place_bet(p_player_name, p_room_id, p_round, p_bet_type, p_symbol, p_amount) → json
dice_cancel_bet(p_player_name, p_room_id, p_round, p_bet_type, p_symbol) → json
dice_resolve_round(p_room_id, p_round, p_dice_result int[]) → json
dice_get_my_result(p_player_name, p_room_id, p_round) → json
dice_get_leaderboard(p_room_id) → json
dice_get_bet_stats(p_room_id, p_round) → json
```

### Realtime Channel

| Channel | 類型 | 方向 | 事件 | 用途 |
|---------|------|------|------|------|
| `dice-state-broadcast` | broadcast | Admin→Player | `state-change` | 狀態推播 |
| `dice-result-broadcast` | broadcast | Admin→Player | `round-result` | 結算結果 |
| `dice-control` | postgres_changes | DB→Player | `dice_game_status` UPDATE | 狀態 fallback |
| `admin-dice-bets-sync` | postgres_changes | DB→Admin | `dice_bets` INSERT | 即時押注統計 |
| `admin-dice-players-sync` | postgres_changes | DB→Admin | `dice_players` * | 玩家列表 |

## 開發注意事項

- 前端使用 CDN 引入（Supabase JS、Tailwind、confetti），不使用 bundler
- Supabase 連線設定寫在 HTML 內的 `<script>` 區塊
- Admin 和 Player 各自獨立的 Realtime channel，不共用
- 媒體檔案存在 Supabase Storage `question-media` bucket
- 所有使用者可見的文字使用繁體中文
