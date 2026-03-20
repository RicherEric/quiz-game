/**
 * Environment variables and configuration constants.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// ─── Load .env ─────────────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = join(__dirname, '..', '.env');
try {
  const envContent = readFileSync(envPath, 'utf-8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();
    if (!process.env[key]) process.env[key] = value;
  }
} catch {
  console.warn('  Warning: .env file not found, using environment variables directly.');
}

// ─── Config ────────────────────────────────────────────────────────────────────

export const SUPABASE_URL = process.env.SUPABASE_URL;
export const SUPABASE_KEY = process.env.SUPABASE_KEY;
export const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
export const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
export const SITE_URL = (process.env.SITE_URL || '').replace(/\/+$/, '');

if (!SUPABASE_URL || !SUPABASE_KEY || !ADMIN_PASSWORD) {
  console.error('Missing required env vars: SUPABASE_URL, SUPABASE_KEY, ADMIN_PASSWORD');
  console.error('Create a .env file in the e2e-test/ directory. See .env.example');
  process.exit(1);
}

export const NUM_PLAYERS = 100;
export const ANSWER_TIMEOUT_MS = 30000;  // Admin waits up to 30s for all players to answer

// ─── Dice Constants ─────────────────────────────────────────────────────────

export const NUM_DICE_PLAYERS = 100;
export const NUM_ROUNDS = 3;
export const DICE_CHIP_VALUES = [100, 200, 500];
export const BETTING_TIMEOUT_MS = 35000;

// ─── Mutable game group ID (set at runtime from game_status.current_group_id) ──

let _gameGroupId = null;

export function getGameGroupId() {
  return _gameGroupId;
}

export function setGameGroupId(id) {
  _gameGroupId = id;
}

// ─── Mutable dice room state ────────────────────────────────────────────────

let _diceRoomId = null;
let _diceQrToken = null;

export function getDiceRoomId() { return _diceRoomId; }
export function setDiceRoomId(id) { _diceRoomId = id; }
export function getDiceQrToken() { return _diceQrToken; }
export function setDiceQrToken(token) { _diceQrToken = token; }

/** Base directory for the e2e-test folder */
export const E2E_DIR = join(__dirname, '..');
