/**
 * Player simulation: createPlayer factory.
 */
import { getGameGroupId } from '../config.mjs';
import { sleep, randomInt, randomSleep, now, withRetry, weightedChoice, padNum } from '../helpers.mjs';
import { stats, initQStats, recordStep, recordError } from '../timing.mjs';
import { newClient } from './admin.mjs';

// ─── Player Simulation ─────────────────────────────────────────────────────────

export function createPlayer(index, qrToken) {
  const name = `test_user_${padNum(index)}`;
  const client = newClient();
  let channel = null;
  let broadcastChannel = null;
  let scoreBroadcastChannel = null;
  let lastStateReceivedAt = 0;
  const pendingScores = {};  // questionId -> { question_score, total_score, receivedAt }

  stats.playerLogs[name] = { joinTimeMs: 0, joinSuccess: false, answers: [] };

  return {
    name,

    async join() {
      await randomSleep(0, 2000);

      const t0 = now();
      const { data, error } = await withRetry(
        () => client.rpc('join_via_qr', { qr_token: qrToken, player_name: name }),
        { maxRetries: 3, baseDelayMs: 1000, label: `player-join(${name})` }
      );
      const dur = now() - t0;

      stats.playerLogs[name].joinTimeMs = dur;
      recordStep('join', 'player-join', name, dur, !error);

      if (error) {
        stats.playersFailed++;
        stats.playerLogs[name].joinSuccess = false;
        recordError(`player-join(${name})`, error);
        return false;
      }
      stats.playersCreated++;
      stats.playerLogs[name].joinSuccess = true;
      return true;
    },

    /**
     * Subscribe to game_status realtime and record propagation lag.
     * Returns a Promise that resolves when subscription is confirmed (SUBSCRIBED),
     * or rejects after timeoutMs.
     */
    subscribe(onStateChange, timeoutMs = 15000) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`Realtime subscribe timeout for player-${name}`));
        }, timeoutMs);

        // 主通道：broadcast channel（延遲最低）
        broadcastChannel = client
          .channel('game-state-broadcast', { config: { broadcast: { self: false } } })
          .on('broadcast', { event: 'state-change' }, (msg) => {
            lastStateReceivedAt = Date.now();
            if (onStateChange) onStateChange(name, msg.payload, lastStateReceivedAt);
          })
          .subscribe();

        // 分數 broadcast channel（與 index.html 一致）
        scoreBroadcastChannel = client
          .channel('score-broadcast', { config: { broadcast: { self: false } } })
          .on('broadcast', { event: 'score-update' }, (msg) => {
            const payload = msg.payload;
            if (payload && payload.scores && payload.scores[name]) {
              pendingScores[payload.question_id] = {
                ...payload.scores[name],
                receivedAt: Date.now(),
              };
            }
          })
          .subscribe();

        // Fallback：postgres_changes
        channel = client
          .channel(`player-${name}`)
          .on(
            'postgres_changes',
            { event: 'UPDATE', schema: 'public', table: 'game_status', filter: 'id=eq.1' },
            (payload) => {
              lastStateReceivedAt = Date.now();
              if (onStateChange) onStateChange(name, payload.new, lastStateReceivedAt);
            }
          )
          .subscribe((status) => {
            if (status === 'SUBSCRIBED') {
              clearTimeout(timer);
              resolve(true);
            } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
              clearTimeout(timer);
              reject(new Error(`Realtime subscribe failed for player-${name}: ${status}`));
            }
          });
      });
    },

    isSubscribed() {
      return channel && channel.state === 'joined';
    },

    getLastStateReceivedAt() {
      return lastStateReceivedAt;
    },

    /**
     * Check if score was received via broadcast (like pendingScore in index.html).
     */
    getPendingScore(questionId) {
      return pendingScores[questionId] || null;
    },

    async answer(questionId, isAborted) {
      initQStats(questionId);
      const qs = stats.perQuestion[questionId];

      // All players answer (no random skip)


      // Random thinking time 1-12s
      const thinkTime = randomInt(1000, 12000);
      await sleep(thinkTime);
      if (isAborted?.()) { qs.skipped++; return; }
      await randomSleep(200, 800);
      if (isAborted?.()) { qs.skipped++; return; }

      const choice = weightedChoice();
      const responseTimeMs = thinkTime + randomInt(200, 800);

      const t0 = now();
      const { error } = await withRetry(
        () => client.rpc('submit_response', {
          p_player_name: name,
          p_question_id: questionId,
          p_choice: choice,
          p_response_time_ms: responseTimeMs,
          p_qr_token: qrToken,
        }),
        { maxRetries: 2, baseDelayMs: 500, label: `player-answer(${name})` }
      );
      const apiTime = now() - t0;

      qs.submitted++;
      qs.apiTimes.push(apiTime);

      if (error) {
        qs.failed++;
        stats.playerLogs[name].answers.push({
          questionId, choice, responseTimeMs, apiTimeMs: apiTime, skipped: false, success: false,
        });
        recordError(`player-answer(${name}, q${questionId})`, error);
      } else {
        qs.succeeded++;
        qs.responseTimes.push(responseTimeMs);
        stats.playerLogs[name].answers.push({
          questionId, choice, responseTimeMs, apiTimeMs: apiTime, skipped: false, success: true,
        });
      }
    },

    /**
     * Poll game_status (like the 2s fallback in index.html).
     */
    async poll() {
      const t0 = now();
      const { data } = await client.from('game_status').select('*').eq('id', 1).single();
      return { durationMs: now() - t0, data };
    },

    /**
     * Fetch own score (like scoring-ui in index.html).
     */
    async fetchMyScore(questionId) {
      const gameGroupId = getGameGroupId();
      const t0 = now();
      const { data } = await client.rpc('get_my_score', {
        p_player_name: name, p_question_id: questionId, p_group_id: gameGroupId
      });
      const dur = now() - t0;
      return { durationMs: dur, questionScore: data?.question_score || 0, totalScore: data?.total_score || 0 };
    },

    /**
     * Fetch final leaderboard (like end-ui in index.html).
     */
    async fetchEndLeaderboard() {
      const gameGroupId = getGameGroupId();
      const t0 = now();
      const { data } = await client.from('player_scores')
        .select('player_name, score')
        .eq('group_id', gameGroupId)
        .order('score', { ascending: false });
      const dur = now() - t0;
      const rank = data ? data.findIndex(p => p.player_name === name) + 1 : -1;
      return { durationMs: dur, rank, total: data?.length || 0 };
    },

    async cleanup() {
      if (scoreBroadcastChannel) await client.removeChannel(scoreBroadcastChannel);
      if (broadcastChannel) await client.removeChannel(broadcastChannel);
      if (channel) await client.removeChannel(channel);
    },
  };
}
