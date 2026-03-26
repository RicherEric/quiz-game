/**
 * Player simulation: createPlayer factory.
 *
 * Each player has its own Supabase client for REST API calls (RPC, queries),
 * but realtime subscriptions are shared via realtime-hub.mjs (1 client, 3 channels)
 * to avoid 70×3=210 subscriptions overwhelming Supabase.
 */
import { getGameGroupId } from '../config.mjs';
import { sleep, randomInt, randomSleep, now, withRetry, weightedChoice, padNum } from '../helpers.mjs';
import { stats, initQStats, recordStep, recordError } from '../timing.mjs';
import { newClient } from './admin.mjs';
import { registerPlayer, unregisterPlayer, getLastReceivedAt, getPendingScore } from './realtime-hub.mjs';

// ─── Player Simulation ─────────────────────────────────────────────────────────

export function createPlayer(index, qrToken) {
  const name = `test_user_${padNum(index)}`;
  const client = newClient();  // REST-only (no realtime subscriptions)

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
     * Register this player with the shared realtime hub.
     * The hub dispatches broadcast/postgres_changes events to all registered players.
     */
    registerRealtime(onStateChange) {
      registerPlayer(name, onStateChange);
    },

    isSubscribed() {
      return true;  // Hub manages subscription state
    },

    getLastStateReceivedAt() {
      return getLastReceivedAt(name);
    },

    /**
     * Check if score was received via broadcast (like pendingScore in index.html).
     */
    getPendingScore(questionId) {
      return getPendingScore(name, questionId);
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
      unregisterPlayer(name);
    },
  };
}
