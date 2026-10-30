import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { DEFAULT_BOT_OWNER_IDS, isBotOwner } from './access.js';

export const OWNER_PIN_TTL_MS = 24 * 60 * 60 * 1000; // 24 giờ cho Chủ Bot
export const DJ_PIN_TTL_MS = 2 * 60 * 60 * 1000; // 2 giờ cho người đang cầm quyền bài hát
export const ALLOWED_REMOTE_ACTIONS = new Set([
 'verify',
 'toggle_pause',
 'skip',
 'previous',
 'replay',
 'shuffle',
 'loop',
 'autoplay',
 'volume',
 'preset',
 'vibe',
 'ambient',
 'play',
]);

export function hashPinWithSalt(salt, pin) {
 return createHash('sha256')
  .update(`bot-dis-2-webpin-v1:${salt}:${String(pin ?? '').trim()}`)
  .digest('hex');
}

function safeHexEqual(a, b) {
 if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length || a.length % 2 !== 0) {
  return false;
 }
 try {
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
 } catch {
  return false;
 }
}

function generateSixDigitPin() {
 return String(randomInt(100000, 1000000));
}

export function normalizeRemoteCommandInput(body) {
 if (!body || typeof body !== 'object') {
  throw new Error('Dữ liệu điều khiển không hợp lệ.');
 }
 const action = String(body.action ?? '').trim();
 if (!ALLOWED_REMOTE_ACTIONS.has(action)) {
  throw new Error('Thao tác điều khiển từ xa không được hỗ trợ.');
 }
 let value = body.value ?? null;
 if (action === 'volume') {
  const num = Math.round(Number(value));
  if (!Number.isFinite(num) || num < 0 || num > 200) {
   throw new Error('Mức âm lượng phải nằm trong khoảng 0% – 200%.');
  }
  value = num;
 } else if (action === 'play') {
  const q = String(value ?? '').trim().slice(0, 300);
  if (q.length < 2) {
   throw new Error('Hãy nhập tên bài hát hoặc đường dẫn hợp lệ (tối thiểu 2 ký tự).');
  }
  value = q;
 } else if (typeof value === 'string') {
  value = value.trim().slice(0, 40);
 }
 return {
  action,
  value,
  playNext: Boolean(body.playNext),
 };
}

// Bộ quản lý mã PIN 6 số điều khiển nhạc 2 chiều từ Website (không cần Ngrok, không cần OAuth2, ~0 MB RAM).
export function createWebRemoteManager({ env = process.env, nowFn = () => Date.now() } = {}) {
 let salt = randomBytes(16).toString('hex');
 let ownerEntry = null; // { pin, userId, expiresAt }
 let djEntry = null; // { pin, userId, expiresAt }
 const failedAttempts = new Map(); // ipKey -> { count, resetAt }
 const executedIds = new Set();

 function pruneExpired() {
  const now = nowFn();
  if (ownerEntry && now >= ownerEntry.expiresAt) ownerEntry = null;
  if (djEntry && now >= djEntry.expiresAt) djEntry = null;
 }

 function issueOrGetPin(userId, { rotate = false } = {}) {
  pruneExpired();
  const now = nowFn();
  const uid = String(userId ?? '').trim();
  const owner = isBotOwner(uid, env);

  if (owner) {
   if (!ownerEntry || rotate) {
    salt = randomBytes(16).toString('hex');
    let nextPin = generateSixDigitPin();
    if (djEntry && nextPin === djEntry.pin) nextPin = generateSixDigitPin();
    ownerEntry = {
     pin: nextPin,
     userId: uid || DEFAULT_BOT_OWNER_IDS[0],
     role: 'owner',
     expiresAt: now + OWNER_PIN_TTL_MS,
    };
   }
   return { ...ownerEntry, createdNew: rotate };
  }

  if (!djEntry || djEntry.userId !== uid || rotate) {
   let nextPin = generateSixDigitPin();
   if (ownerEntry && nextPin === ownerEntry.pin) nextPin = generateSixDigitPin();
   djEntry = {
    pin: nextPin,
    userId: uid,
    role: 'dj',
    expiresAt: now + DJ_PIN_TTL_MS,
   };
  }
  return { ...djEntry, createdNew: rotate };
 }

 function revokePin(userId) {
  pruneExpired();
  const uid = String(userId ?? '').trim();
  if (isBotOwner(uid, env)) {
   const hadAny = Boolean(ownerEntry || djEntry);
   ownerEntry = null;
   djEntry = null;
   salt = randomBytes(16).toString('hex');
   return hadAny;
  }
  if (djEntry && djEntry.userId === uid) {
   djEntry = null;
   return true;
  }
  return false;
 }

 function verifyPin(rawPin, clientKey = 'global') {
  pruneExpired();
  const now = nowFn();
  const bucket = failedAttempts.get(clientKey);
  if (bucket && now < bucket.resetAt && bucket.count >= 5) {
   return { ok: false, locked: true, error: 'Nhập sai mã PIN quá 5 lần — vui lòng chờ 60 giây rồi thử lại.' };
  }

  const cleanPin = String(rawPin ?? '').trim();
  if (!/^\d{6}$/.test(cleanPin)) {
   return { ok: false, error: 'Mã PIN gồm đúng 6 chữ số (gõ /webkey trong Discord để lấy mã).' };
  }

  const candHash = hashPinWithSalt(salt, cleanPin);
  if (ownerEntry && safeHexEqual(candHash, hashPinWithSalt(salt, ownerEntry.pin))) {
   failedAttempts.delete(clientKey);
   return { ok: true, role: 'owner', userId: ownerEntry.userId, expiresAt: ownerEntry.expiresAt };
  }
  if (djEntry && safeHexEqual(candHash, hashPinWithSalt(salt, djEntry.pin))) {
   failedAttempts.delete(clientKey);
   return { ok: true, role: 'dj', userId: djEntry.userId, expiresAt: djEntry.expiresAt };
  }

  const curCount = (bucket && now < bucket.resetAt ? bucket.count : 0) + 1;
  if (failedAttempts.size >= 50) failedAttempts.clear();
  failedAttempts.set(clientKey, { count: curCount, resetAt: now + 60_000 });
  return { ok: false, error: 'Mã PIN không đúng hoặc đã hết hạn — gõ /webkey trong Discord để lấy mã mới.' };
 }

 function exportWorkerAuth() {
  pruneExpired();
  const entries = [];
  if (ownerEntry) {
   entries.push({
    role: 'owner',
    userId: ownerEntry.userId,
    hash: hashPinWithSalt(salt, ownerEntry.pin),
    expiresAt: ownerEntry.expiresAt,
   });
  }
  if (djEntry) {
   entries.push({
    role: 'dj',
    userId: djEntry.userId,
    hash: hashPinWithSalt(salt, djEntry.pin),
    expiresAt: djEntry.expiresAt,
   });
  }
  return { salt, entries };
 }

 function hasActivePins() {
  pruneExpired();
  return Boolean(ownerEntry || djEntry);
 }

 function markCommandExecuted(cmdId) {
  const id = String(cmdId ?? '').trim();
  if (!id) return true;
  if (executedIds.has(id)) return false;
  if (executedIds.size >= 80) {
   const oldest = executedIds.values().next().value;
   if (oldest) executedIds.delete(oldest);
  }
  executedIds.add(id);
  return true;
 }

 return {
  issueOrGetPin,
  revokePin,
  verifyPin,
  exportWorkerAuth,
  hasActivePins,
  markCommandExecuted,
 };
}
