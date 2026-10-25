import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { resolveHumanRequester } from './access.js';
import { renderSyncedProgress } from './playerGui.js';

export const DEFAULT_SESSION_FILE = resolve(process.cwd(), '.runtime-session.json');
export const RESTART_NORMAL_TTL_MS = 2 * 60 * 60 * 1000;       // Phiên thường: tự vào lại phòng nếu bot vừa reset/update trong vòng 2 giờ.
export const RESTART_247_TTL_MS = 7 * 24 * 60 * 60 * 1000;     // Phiên 24/7: tự vào lại phòng ngay cả sau khi bảo trì dài hạn (tối đa 7 ngày).

// Sao lưu gọn nhẹ thông tin bài hát để ghi ra đĩa hoặc mã hóa dự phòng (< 500 byte/bài).
export function cloneSerializableTrack(t) {
 if (!t || typeof t !== 'object' || !t.url) return null;
 return {
  id: t.id ? String(t.id) : undefined,
  title: String(t.title ?? 'Không rõ'),
  url: String(t.url),
  duration: Number(t.duration) || 0,
  thumbnail: typeof t.thumbnail === 'string' ? t.thumbnail : undefined,
  requestedBy: t.requestedBy ? String(t.requestedBy) : undefined,
  source: t.source ? String(t.source) : 'soundcloud',
  metadata: t.metadata?.author ? { author: String(t.metadata.author) } : {},
 };
}

// Chụp lại toàn bộ trạng thái phòng thoại, chế độ 24/7, âm lượng (0-200%), chất âm, bài đang phát & mốc giây hiện tại của 1 máy chủ.
export function capturePlayerSessionSnapshot(player, now = Date.now()) {
 if (!player || player.destroyed) return null;
 const guildId = player.guildId ? String(player.guildId) : null;
 const voiceChannelId = player.userdata?.voiceChannelId ? String(player.userdata.voiceChannelId) : null;
 if (!guildId || !voiceChannelId) return null;

 const cur = player.queue?.currentTrack ?? player.currentTrack ?? null;
 const clonedCur = cloneSerializableTrack(cur);
 const upcoming = (Array.isArray(player.upcomingTracks) ? player.upcomingTracks : [])
  .slice(0, 20)
  .map(cloneSerializableTrack)
  .filter(Boolean);

 let positionMs = 0;
 if (cur) {
  const { currentMs, totalMs } = renderSyncedProgress(player, cur, Boolean(player.isPaused));
  if (currentMs >= 3000 && (!totalMs || currentMs < totalMs - 4000)) {
   positionMs = Math.round(currentMs);
  }
 }

 const textChannelId = player.userdata?.textChannel?.id
  ?? player.userdata?.textChannelId
  ?? null;

 return {
  guildId,
  voiceChannelId,
  textChannelId: textChannelId ? String(textChannelId) : null,
  ownerId: resolveHumanRequester(cur?.requestedBy) || resolveHumanRequester(player.userdata?.ownerId) || null,
  stay247: Boolean(player.userdata?.stay247),
  volume: Number.isFinite(player.volume) ? Math.round(player.volume) : 100,
  soundPreset: player.userdata?.soundPreset ?? 'hd',
  loopMode: (typeof player.loop === 'function' ? player.loop() : 'off') ?? 'off',
  autoPlay: typeof player.autoPlay === 'function' ? Boolean(player.autoPlay()) : false,
  wasPaused: Boolean(player.isPaused && !player.userdata?.autoPausedByMute),
  currentTrack: clonedCur,
  positionMs,
  upcomingTracks: upcoming,
  savedAt: now,
 };
}

export function isSessionSnapshotFresh(snap, now = Date.now()) {
 if (!snap || typeof snap !== 'object' || !snap.guildId || !snap.voiceChannelId) return false;
 const savedAt = Number(snap.savedAt) || 0;
 if (savedAt <= 0) return false;
 const ttl = snap.stay247 ? RESTART_247_TTL_MS : RESTART_NORMAL_TTL_MS;
 return now - savedAt <= ttl;
}

function deriveSealKey(secret) {
 const clean = String(secret ?? '').trim();
 if (!clean) return null;
 return createHash('sha256').update(`bot-dis-2-session-seal-v1:${clean}`).digest();
}

// Mã hóa xác thực AES-256-GCM để sao lưu trạng thái phòng lên Cloudflare Durable Object mà không lộ bất kỳ ID nào ra ngoài.
export function sealSessionPayload(sessionsObj, secret) {
 const key = deriveSealKey(secret);
 if (!key || !sessionsObj || typeof sessionsObj !== 'object') return null;
 const iv = randomBytes(12);
 const cipher = createCipheriv('aes-256-gcm', key, iv);
 const plaintext = Buffer.from(JSON.stringify({ v: 1, sessions: sessionsObj }), 'utf8');
 const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
 const tag = cipher.getAuthTag();
 return `${iv.toString('base64url')}.${tag.toString('base64url')}.${encrypted.toString('base64url')}`;
}

export function openSessionPayload(sealed, secret) {
 const key = deriveSealKey(secret);
 if (!key || typeof sealed !== 'string') return null;
 const parts = sealed.split('.');
 if (parts.length !== 3) return null;
 try {
  const iv = Buffer.from(parts[0], 'base64url');
  const tag = Buffer.from(parts[1], 'base64url');
  const encrypted = Buffer.from(parts[2], 'base64url');
  if (iv.length !== 12 || tag.length !== 16) return null;
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
  const parsed = JSON.parse(plain);
  if (parsed?.v !== 1 || !parsed.sessions || typeof parsed.sessions !== 'object') return null;
  return parsed.sessions;
 } catch {
  return null;
 }
}

// Bộ lưu trữ phiên hoạt động bền vững trên ổ đĩa cục bộ (ghi nguyên tử .tmp -> rename chống hỏng file khi tắt đột ngột).
export function createRuntimeSessionStore({
 filePath = DEFAULT_SESSION_FILE,
 nowFn = () => Date.now(),
} = {}) {
 const sessions = new Map();
 let writeTimer = null;

 function loadFromDisk() {
  if (!filePath || !existsSync(filePath)) return;
  try {
   const raw = JSON.parse(readFileSync(filePath, 'utf8'));
   const entries = raw?.sessions && typeof raw.sessions === 'object' ? Object.values(raw.sessions) : [];
   const now = nowFn();
   for (const snap of entries) {
    if (isSessionSnapshotFresh(snap, now)) {
     sessions.set(String(snap.guildId), snap);
    }
   }
  } catch {}
 }

 function writeToDiskSync() {
  if (writeTimer) {
   clearTimeout(writeTimer);
   writeTimer = null;
  }
  if (!filePath) return;
  try {
   const now = nowFn();
   for (const [gid, snap] of sessions) {
    if (!isSessionSnapshotFresh(snap, now)) sessions.delete(gid);
   }
   if (sessions.size === 0) {
    if (existsSync(filePath)) unlinkSync(filePath);
    return;
   }
   const obj = Object.fromEntries(sessions.entries());
   const tmpPath = `${filePath}.tmp`;
   writeFileSync(tmpPath, JSON.stringify({ v: 1, updatedAt: now, sessions: obj }), 'utf8');
   renameSync(tmpPath, filePath);
  } catch {}
 }

 function scheduleWrite(delayMs = 600) {
  if (writeTimer) return;
  writeTimer = setTimeout(() => {
   writeTimer = null;
   writeToDiskSync();
  }, delayMs);
  writeTimer.unref?.();
 }

 loadFromDisk();

 return {
  savePlayer(player, { immediate = false } = {}) {
   const snap = capturePlayerSessionSnapshot(player, nowFn());
   if (!snap) return null;
   if (sessions.size >= 10 && !sessions.has(snap.guildId)) {
    const oldestKey = sessions.keys().next().value;
    sessions.delete(oldestKey);
   }
   sessions.set(snap.guildId, snap);
   if (immediate) writeToDiskSync();
   else scheduleWrite();
   return snap;
  },

  removeGuild(guildId, { immediate = true } = {}) {
   if (!guildId) return;
   const deleted = sessions.delete(String(guildId));
   if (!deleted) return;
   if (immediate) writeToDiskSync();
   else scheduleWrite();
  },

  flushAllSync(players = []) {
   const now = nowFn();
   for (const p of players) {
    const snap = capturePlayerSessionSnapshot(p, now);
    if (snap) sessions.set(snap.guildId, snap);
   }
   writeToDiskSync();
  },

  exportSessionsObject() {
   const now = nowFn();
   const out = {};
   for (const [gid, snap] of sessions) {
    if (isSessionSnapshotFresh(snap, now)) out[gid] = snap;
   }
   return out;
  },

  importFallbackSessions(sessionsObj) {
   if (!sessionsObj || typeof sessionsObj !== 'object') return 0;
   const now = nowFn();
   let imported = 0;
   for (const snap of Object.values(sessionsObj)) {
    if (isSessionSnapshotFresh(snap, now) && !sessions.has(String(snap.guildId))) {
     sessions.set(String(snap.guildId), snap);
     imported++;
    }
   }
   if (imported > 0) writeToDiskSync();
   return imported;
  },

  getRestorableSessions() {
   const now = nowFn();
   const list = [];
   for (const [gid, snap] of sessions) {
    if (isSessionSnapshotFresh(snap, now)) list.push(snap);
    else sessions.delete(gid);
   }
   return list;
  },

  hasAny() {
   return sessions.size > 0;
  },
 };
}
