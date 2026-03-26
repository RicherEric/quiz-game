/**
 * Shared Realtime Hub: 1 client, 3 channels, dispatches to all registered players.
 *
 * Instead of 70 players × 3 channels = 210 subscriptions (70 postgres_changes!),
 * this hub creates only 3 subscriptions total and fans out events to all players.
 */
import { newClient } from './admin.mjs';

// Single shared client for all realtime
const sharedClient = newClient();

// Player registry: name -> { onState, pendingScores, lastReceivedAt }
const players = new Map();

let broadcastCh = null;
let scoreCh = null;
let pgChangesCh = null;
let subscribed = false;

/**
 * Register a player to receive realtime events.
 */
export function registerPlayer(name, onStateChange) {
  players.set(name, {
    onState: onStateChange,
    pendingScores: {},
    lastReceivedAt: 0,
  });
}

export function unregisterPlayer(name) {
  players.delete(name);
}

export function getLastReceivedAt(name) {
  return players.get(name)?.lastReceivedAt || 0;
}

export function getPendingScore(name, questionId) {
  return players.get(name)?.pendingScores[questionId] || null;
}

/**
 * Subscribe the shared channels. Call once after all players are registered.
 */
export function subscribeAll(timeoutMs = 15000) {
  if (subscribed) return Promise.resolve();

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Shared realtime subscribe timeout')), timeoutMs);

    // Broadcast: game state (lowest latency)
    broadcastCh = sharedClient
      .channel('game-state-broadcast', { config: { broadcast: { self: false } } })
      .on('broadcast', { event: 'state-change' }, (msg) => {
        const ts = Date.now();
        for (const [name, p] of players) {
          p.lastReceivedAt = ts;
          if (p.onState) p.onState(name, msg.payload, ts);
        }
      })
      .subscribe();

    // Broadcast: score updates
    scoreCh = sharedClient
      .channel('score-broadcast', { config: { broadcast: { self: false } } })
      .on('broadcast', { event: 'score-update' }, (msg) => {
        const payload = msg.payload;
        if (!payload?.scores) return;
        const ts = Date.now();
        for (const [name, p] of players) {
          if (payload.scores[name]) {
            p.pendingScores[payload.question_id] = {
              ...payload.scores[name],
              receivedAt: ts,
            };
          }
        }
      })
      .subscribe();

    // Fallback: postgres_changes (SINGLE subscription for all players)
    pgChangesCh = sharedClient
      .channel('shared-quiz-control')
      .on('postgres_changes', {
        event: 'UPDATE', schema: 'public', table: 'game_status', filter: 'id=eq.1',
      }, (payload) => {
        const ts = Date.now();
        for (const [name, p] of players) {
          p.lastReceivedAt = ts;
          if (p.onState) p.onState(name, payload.new, ts);
        }
      })
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          clearTimeout(timer);
          subscribed = true;
          resolve();
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          clearTimeout(timer);
          reject(new Error(`Shared realtime subscribe failed: ${status}`));
        }
      });
  });
}

/**
 * Cleanup all shared channels.
 */
export async function cleanupAll() {
  if (broadcastCh) await sharedClient.removeChannel(broadcastCh);
  if (scoreCh) await sharedClient.removeChannel(scoreCh);
  if (pgChangesCh) await sharedClient.removeChannel(pgChangesCh);
  broadcastCh = null;
  scoreCh = null;
  pgChangesCh = null;
  players.clear();
  subscribed = false;
}
