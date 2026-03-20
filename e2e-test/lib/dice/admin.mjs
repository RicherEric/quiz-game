/**
 * Dice Admin: Supabase RPC operations + browser automation (Playwright clicks).
 */
import { createClient } from '@supabase/supabase-js';
import { SUPABASE_URL, SUPABASE_KEY, getDiceRoomId, setDiceRoomId, setDiceQrToken } from '../config.mjs';
import { sleep, now, fmtMs, withRetry } from '../helpers.mjs';
import { recordStep, recordError } from '../timing.mjs';
import { getDiceAdminPage } from '../browser.mjs';

// ─── Supabase Client ────────────────────────────────────────────────────────

export function newDiceClient() {
  return createClient(SUPABASE_URL, SUPABASE_KEY, {
    realtime: { params: { eventsPerSecond: 10 } },
  });
}

export const diceAdmin = newDiceClient();

// ─── Supabase RPC Operations ────────────────────────────────────────────────

export async function cleanDiceTestData() {
  const t0 = now();
  const roomId = getDiceRoomId();

  // Delete test bets
  const { error: e1 } = await diceAdmin.from('dice_bets').delete().like('player_name', 'test_%');
  if (e1) recordError('clean-dice-bets', e1);

  // Delete test players
  const { error: e2 } = await diceAdmin.from('dice_players').delete().like('player_name', 'test_%');
  if (e2) recordError('clean-dice-players', e2);

  // Reset game status if we have a room
  if (roomId) {
    const { error: e3 } = await diceAdmin.from('dice_game_status').update({
      state: 'waiting', current_round: 0, dice_result: [], start_time: 0,
    }).eq('room_id', roomId);
    if (e3) recordError('reset-dice-game-status', e3);

    // Verify reset
    const { data: verify } = await diceAdmin.from('dice_game_status')
      .select('state, current_round').eq('room_id', roomId).single();
    if (verify) {
      console.log(`  [verify] game_status after reset: state=${verify.state}, current_round=${verify.current_round}`);
    }
  }

  const dur = now() - t0;
  recordStep('setup', 'clean-dice-test-data', '', dur);
  console.log(`  Old dice test data cleaned (${fmtMs(dur)})`);
}

export async function fetchDiceRoomId() {
  const t0 = now();
  const { data, error } = await diceAdmin.from('dice_rooms').select('id').limit(1).single();
  const dur = now() - t0;
  recordStep('setup', 'fetch-dice-room-id', '', dur, !error && !!data);
  if (error || !data) throw new Error(`Failed to fetch dice room: ${error?.message || 'no room'}`);
  setDiceRoomId(data.id);
  return data.id;
}

export async function fetchDiceQrToken(roomId) {
  const t0 = now();
  const { data, error } = await diceAdmin.from('dice_rooms').select('qr_token').eq('id', roomId).single();
  const dur = now() - t0;
  recordStep('setup', 'fetch-dice-qr-token', '', dur, !error && !!data);
  if (error || !data) throw new Error(`Failed to fetch dice QR token: ${error?.message || 'no token'}`);
  setDiceQrToken(data.qr_token);
  return data.qr_token;
}

export async function fetchBetStats(roomId, round) {
  const t0 = now();
  const { data, error } = await diceAdmin.rpc('dice_get_bet_stats', {
    p_room_id: roomId, p_round: round,
  });
  const dur = now() - t0;
  recordStep('admin', 'fetch-bet-stats', `room=${roomId}, round=${round}`, dur, !error);
  return { durationMs: dur, data: data || {} };
}

export async function fetchDiceLeaderboard(roomId) {
  const t0 = now();
  const { data, error } = await diceAdmin.rpc('dice_get_leaderboard', { p_room_id: roomId });
  const dur = now() - t0;
  recordStep('admin', 'fetch-dice-leaderboard', `${data?.length || 0} players`, dur, !error);
  return { durationMs: dur, players: data || [] };
}

export async function adminResolveViaRPC(roomId, round, diceResult) {
  const t0 = now();
  const { data, error } = await withRetry(
    () => diceAdmin.rpc('dice_resolve_round', {
      p_room_id: roomId, p_round: round, p_dice_result: diceResult,
    }),
    { maxRetries: 2, baseDelayMs: 1000, label: `dice-resolve(round${round})` }
  );
  const dur = now() - t0;
  recordStep('admin', 'dice-resolve-rpc', `room=${roomId}, round=${round}, dice=${JSON.stringify(diceResult)}`, dur, !error);
  if (error) recordError(`dice-resolve-rpc(round${round})`, error);
  return { durationMs: dur, data };
}

// ─── Admin Browser Automation ───────────────────────────────────────────────

export async function adminSelectRoom(roomId) {
  const adminPage = getDiceAdminPage();
  await adminPage.waitForFunction(
    (rId) => {
      const sel = document.getElementById('room-selector');
      if (!sel) return false;
      return Array.from(sel.options).some(o => o.value === String(rId));
    },
    roomId,
    { timeout: 15000 }
  );
  await adminPage.selectOption('#room-selector', String(roomId));
  await sleep(500);
  console.log(`  Admin selected dice room ${roomId}`);
}

export async function adminClickStartBetting() {
  const adminPage = getDiceAdminPage();
  const sentAt = Date.now();
  const t0 = now();
  await adminPage.click('#btn-start-betting');
  await adminPage.waitForFunction(
    () => document.getElementById('current-state-label')?.innerText?.includes('押注中'),
    { timeout: 10000 }
  );
  const dur = now() - t0;
  recordStep('admin-browser', 'click-start-betting', '', dur);
  return { durationMs: dur, sentAt };
}

export async function adminClickStopBetting() {
  const adminPage = getDiceAdminPage();
  const sentAt = Date.now();
  const t0 = now();
  await adminPage.click('#btn-stop-betting');
  await adminPage.waitForFunction(
    () => document.getElementById('current-state-label')?.innerText?.includes('已停止押注'),
    { timeout: 10000 }
  );
  const dur = now() - t0;
  recordStep('admin-browser', 'click-stop-betting', '', dur);
  return { durationMs: dur, sentAt };
}

export async function adminClickRollRandom() {
  const adminPage = getDiceAdminPage();
  const sentAt = Date.now();
  const t0 = now();
  await adminPage.click('#btn-roll-random');
  await adminPage.waitForFunction(
    () => document.getElementById('current-state-label')?.innerText?.includes('已結算'),
    { timeout: 15000 }  // includes 3s dice animation
  );
  const dur = now() - t0;
  recordStep('admin-browser', 'click-roll-random', '', dur);
  return { durationMs: dur, sentAt };
}

export async function adminClickNextRound() {
  const adminPage = getDiceAdminPage();
  const sentAt = Date.now();
  const t0 = now();
  await adminPage.click('#btn-next-round');
  await adminPage.waitForFunction(
    () => document.getElementById('current-state-label')?.innerText?.includes('等待中'),
    { timeout: 10000 }
  );
  const dur = now() - t0;
  recordStep('admin-browser', 'click-next-round', '', dur);
  return { durationMs: dur, sentAt };
}

export async function adminClickEndGame() {
  const adminPage = getDiceAdminPage();
  adminPage.once('dialog', dialog => dialog.accept());
  const sentAt = Date.now();
  const t0 = now();
  await adminPage.click('#btn-end-game');
  await adminPage.waitForFunction(
    () => document.getElementById('current-state-label')?.innerText?.includes('已結束'),
    { timeout: 10000 }
  );
  const dur = now() - t0;
  recordStep('admin-browser', 'click-end-game', '', dur);
  return { durationMs: dur, sentAt };
}
