/**
 * Dice Player simulation: createDicePlayer factory.
 */
import { DICE_CHIP_VALUES } from '../config.mjs';
import { sleep, randomInt, randomSleep, now, withRetry, padNum } from '../helpers.mjs';
import { stats, initQStats, recordStep, recordError } from '../timing.mjs';
import { newDiceClient } from './admin.mjs';

// ─── Player Factory ─────────────────────────────────────────────────────────

export function createDicePlayer(index, qrToken) {
  const name = `test_dice_${padNum(index)}`;
  const client = newDiceClient();
  let stateChannel = null;
  let resultChannel = null;
  let fallbackChannel = null;
  let lastStateReceivedAt = 0;
  const pendingResults = {};  // round -> { dice_result, bets, ... , receivedAt }
  let balance = 1000;  // track estimated balance to avoid insufficient-balance errors

  stats.playerLogs[name] = { joinTimeMs: 0, joinSuccess: false, answers: [] };

  return {
    name,

    async join() {
      await randomSleep(0, 2000);

      const t0 = now();
      const { data, error } = await withRetry(
        () => client.rpc('dice_join_room', { p_token: qrToken, p_player_name: name }),
        { maxRetries: 3, baseDelayMs: 1000, label: `dice-join(${name})` }
      );
      const dur = now() - t0;

      stats.playerLogs[name].joinTimeMs = dur;
      recordStep('join', 'dice-player-join', name, dur, !error);

      if (error) {
        stats.playersFailed++;
        stats.playerLogs[name].joinSuccess = false;
        recordError(`dice-join(${name})`, error);
        return false;
      }
      stats.playersCreated++;
      stats.playerLogs[name].joinSuccess = true;
      return true;
    },

    /**
     * Subscribe to dice realtime channels.
     * Returns a Promise that resolves when subscription is confirmed.
     */
    subscribe(onStateChange, timeoutMs = 15000) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`Dice realtime subscribe timeout for ${name}`));
        }, timeoutMs);

        // Layer 1: Broadcast — game state
        stateChannel = client
          .channel('dice-state-broadcast', { config: { broadcast: { self: false } } })
          .on('broadcast', { event: 'state-change' }, (msg) => {
            lastStateReceivedAt = Date.now();
            if (onStateChange) onStateChange(name, msg.payload, lastStateReceivedAt);
          })
          .subscribe();

        // Layer 1b: Broadcast — round results
        resultChannel = client
          .channel('dice-result-broadcast', { config: { broadcast: { self: false } } })
          .on('broadcast', { event: 'round-result' }, (msg) => {
            const payload = msg.payload;
            if (payload && payload.results && payload.results[name]) {
              const myResult = payload.results[name];
              pendingResults[payload.round] = {
                ...myResult,
                dice_result: payload.dice_result,
                is_triple: payload.is_triple,
                receivedAt: Date.now(),
              };
              // Sync balance from server result
              if (typeof myResult.balance === 'number') {
                balance = myResult.balance;
              }
            }
          })
          .subscribe();

        // Layer 2: Fallback — postgres_changes (shared channel name matches production dice.html)
        fallbackChannel = client
          .channel('dice-control')
          .on(
            'postgres_changes',
            { event: 'UPDATE', schema: 'public', table: 'dice_game_status' },
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
              reject(new Error(`Dice realtime subscribe failed for ${name}: ${status}`));
            }
          });
      });
    },

    isSubscribed() {
      return fallbackChannel && fallbackChannel.state === 'joined';
    },

    getLastStateReceivedAt() {
      return lastStateReceivedAt;
    },

    /**
     * Check if round result was received via broadcast.
     */
    getPendingResult(round) {
      return pendingResults[round] || null;
    },

    /**
     * Place random bets for a round: 1-3 single bets on random symbols.
     * Tracks balance locally to avoid insufficient-balance errors.
     */
    async placeBets(roomId, round) {
      const roundKey = `round_${round}`;
      initQStats(roundKey);
      const qs = stats.perQuestion[roundKey];

      // Skip if broke
      if (balance <= 0) return [];

      const numBets = randomInt(1, 3);
      const symbols = new Set();
      while (symbols.size < numBets) symbols.add(randomInt(1, 6));

      const results = [];
      let roundSpent = 0;

      for (const symbol of symbols) {
        const remaining = balance - roundSpent;
        if (remaining <= 0) break;

        // Pick affordable chip: filter to chips within remaining balance
        const affordable = DICE_CHIP_VALUES.filter(v => v <= remaining);
        if (affordable.length === 0) break;
        const chip = affordable[randomInt(0, affordable.length - 1)];
        roundSpent += chip;

        // Small stagger between bets
        await randomSleep(50, 300);

        const t0 = now();
        const { data, error } = await withRetry(
          () => client.rpc('dice_place_bet', {
            p_player_name: name,
            p_room_id: roomId,
            p_round: round,
            p_bet_type: 'single',
            p_symbol: symbol,
            p_amount: chip,
          }),
          { maxRetries: 2, baseDelayMs: 500, label: `dice-bet(${name})` }
        );
        const apiTime = now() - t0;

        qs.submitted++;
        qs.apiTimes.push(apiTime);

        if (error) {
          qs.failed++;
          roundSpent -= chip;  // bet didn't go through, reclaim
          results.push({ symbol, chip, success: false, error: error.message });
          recordError(`dice-bet(${name}, r${round}, s${symbol})`, error);
        } else {
          qs.succeeded++;
          results.push({ symbol, chip, success: true });
        }

        stats.playerLogs[name].answers.push({
          questionId: roundKey, choice: symbol, responseTimeMs: chip,
          apiTimeMs: apiTime, skipped: false, success: !error,
        });
      }

      balance -= roundSpent;
      return results;
    },

    /**
     * Fetch own result via RPC fallback.
     */
    async fetchMyResult(roomId, round) {
      const t0 = now();
      const { data, error } = await client.rpc('dice_get_my_result', {
        p_player_name: name, p_room_id: roomId, p_round: round,
      });
      const dur = now() - t0;
      // Sync balance from RPC fallback
      if (data && typeof data.balance === 'number') {
        balance = data.balance;
      }
      return { durationMs: dur, data };
    },

    /**
     * Fetch final leaderboard.
     */
    async fetchEndLeaderboard(roomId) {
      const t0 = now();
      const { data, error } = await client.rpc('dice_get_leaderboard', { p_room_id: roomId });
      const dur = now() - t0;
      const rank = data ? data.findIndex(p => p.player_name === name) + 1 : -1;
      return { durationMs: dur, rank, total: data?.length || 0 };
    },

    async cleanup() {
      if (resultChannel) await client.removeChannel(resultChannel);
      if (stateChannel) await client.removeChannel(stateChannel);
      if (fallbackChannel) await client.removeChannel(fallbackChannel);
    },
  };
}
