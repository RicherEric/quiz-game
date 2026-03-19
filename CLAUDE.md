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
| `e2e-test/load-test.mjs` | E2E 負載測試（100 玩家 + 1 Admin Playwright 自動化） |
| `lottery.html` | 抽獎功能 |

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

## 雙模式系統（official / test）

- `game_status.mode` 決定目前模式
- `questions.type` 篩選題目（`'official'` / `'test'`，null 等同 `'official'`）
- `players.score` vs `players.test_score` 分開累計
- **任何涉及分數的操作都必須根據 `mode` 使用正確欄位**

## RPC 函數簽名（修改時必須維持相容）

```sql
join_via_qr(qr_token text, player_name text) → json
submit_response(p_player_name, p_question_id, p_choice, p_response_time_ms, p_qr_token) → json
score_question(p_question_id, p_correct_answer, p_mode DEFAULT 'official') → json
get_my_score(p_player_name, p_question_id, p_mode DEFAULT 'official') → json
get_response_counts(p_question_id) → json
get_player_stats() → TABLE(player_name, correct_count, avg_time_ms)
reset_question_responses(p_question_id, p_mode DEFAULT 'official') → json
```

## 計分公式

```
scored_points = floor(base_points * (1 + max(0, 15000 - response_time_ms) / 15000 * 0.75) + 0.5)
```

- 答對：base_points（預設 1000）+ 最高 75% 時間獎勵（15 秒內）
- 答錯或未答（choice = 0）：0 分

## E2E 測試

```bash
cd e2e-test && node load-test.mjs
```

- 需要 `.env`（`SUPABASE_URL`, `SUPABASE_KEY`, `ADMIN_PASSWORD`）
- 12 項 pass/fail 指標（API p95 < 2s、Realtime p95 < 3s、成功率 ≥ 95% 等）
- 6 項資料完整性檢查
- 9 項邊界條件測試
- 修改後務必確認測試通過

## table.sql 設計原則

- **冪等**：所有語句用 `IF NOT EXISTS` / `ON CONFLICT DO NOTHING`，可重複執行
- **RPC = SECURITY DEFINER**：繞過 RLS，在函數內部做驗證
- **新增欄位用 `ADD COLUMN IF NOT EXISTS`**，不可刪除既有欄位

## 開發注意事項

- 前端使用 CDN 引入（Supabase JS、Tailwind、confetti），不使用 bundler
- Supabase 連線設定寫在 HTML 內的 `<script>` 區塊
- Admin 和 Player 各自獨立的 Realtime channel，不共用
- 媒體檔案存在 Supabase Storage `question-media` bucket
- 所有使用者可見的文字使用繁體中文
