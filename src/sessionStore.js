import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveHumanRequester } from './access.js';
import { renderSyncedProgress } from './playerGui.js';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_SESSION_FILE = resolve(PROJECT_ROOT, '.runtime-session.json');
export const DEFAULT_TMP_BACKUP_FILE = join(tmpdir(), 'bot-dis-2-runtime-session.json');
export const RESTART_NORMAL_TTL_MS = 2 * 60 * 60 * 1000;       // Phiên thường: tự vào lại phòng nếu bot vừa reset/update trong vòng 2 giờ.
export const RESTART_247_TTL_MS = 7 * 24 * 60 * 60 * 1000;     // Phiên 24/7: tự vào lại phòng ngay cả sau khi bảo trì dài hạn (tối đa 7 ngày).

// Sao lưu gọn nhẹ thông tin bài hát để ghi ra đĩa hoặc mã hóa dự phòng (< 500 byte/bài).
export function cloneSerializableTrack(t) {
 if (!t || typeof t !== 'object' || !t.url) return null;
 const meta = {};
 if (t.metadata?.author) meta.author = String(t.metadata.author);
 if (t.metadata?.dedication && typeof t.metadata.dedication === 'object') {
  const d = t.metadata.dedication;
  meta.dedication = {
   fromId: d.fromId ? String(d.fromId).slice(0, 24) : null,
   fromName: d.fromName ? String(d.fromName).slice(0, 40) : 'Một người bạn',
   toId: d.toId ? String(d.toId).slice(0, 24) : null,
   toName: d.toName ? String(d.toName).slice(0, 40) : 'Bạn',
   message: d.message ? String(d.message).slice(0, 160) : '',
  };
 }
 return {
  id: t.id ? String(t.id) : undefined,
  title: String(t.title ?? 'Không rõ'),
  url: String(t.url),
  duration: Number(t.duration) || 0,
  thumbnail: typeof t.thumbnail === 'string' ? t.thumbnail : undefined,
  requestedBy: t.requestedBy ? String(t.requestedBy) : undefined,
  source: t.source ? String(t.source) : 'soundcloud',
  metadata: meta,
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

// Dự phòng lớp 3: Ngay khoảnh khắc bot vừa đăng nhập lại sau cú crash/reset nhanh, kiểm tra xem Discord Gateway còn giữ trạng thái bot trong phòng thoại nào không.
export function captureGatewayFallbackSessions(readyClient, now = Date.now()) {
 const botId = readyClient?.user?.id;
 if (!botId || !readyClient?.guilds?.cache) return {};
 const out = {};
 for (const guild of readyClient.guilds.cache.values()) {
  const vs = guild?.voiceStates?.cache?.get?.(botId);
  if (vs?.channelId && vs.channelId !== guild.afkChannelId) {
   out[String(guild.id)] = {
    guildId: String(guild.id),
    voiceChannelId: String(vs.channelId),
    textChannelId: null,
    ownerId: null,
    stay247: false,
    volume: 100,
    soundPreset: 'hd',
    loopMode: 'off',
    autoPlay: false,
    wasPaused: false,
    currentTrack: null,
    positionMs: 0,
    upcomingTracks: [],
    savedAt: now,
   };
  }
 }
 return out;
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

function readSessionsFileSafe(targetPath) {
 if (!targetPath || !existsSync(targetPath)) return [];
 try {
  const raw = JSON.parse(readFileSync(targetPath, 'utf8'));
  return raw?.sessions && typeof raw.sessions === 'object' ? Object.values(raw.sessions) : [];
 } catch {
  return [];
 }
}

function writeAtomicJsonSafe(targetPath, payloadStr) {
 if (!targetPath) return;
 try {
  const tmpPath = `${targetPath}.tmp`;
  writeFileSync(tmpPath, payloadStr, 'utf8');
  renameSync(tmpPath, targetPath);
 } catch {}
}

function unlinkSafe(targetPath) {
 if (!targetPath) return;
 try {
  if (existsSync(targetPath)) unlinkSync(targetPath);
 } catch {}
}

// Bộ lưu trữ phiên hoạt động bền vững trên 2 vị trí đĩa cục bộ (thư mục bot + /tmp chống git clean).
export function createRuntimeSessionStore({
 filePath = DEFAULT_SESSION_FILE,
 backupFilePath = filePath === DEFAULT_SESSION_FILE ? DEFAULT_TMP_BACKUP_FILE : null,
 nowFn = () => Date.now(),
} = {}) {
 const sessions = new Map();
 let writeTimer = null;

 function loadFromDisk() {
  const now = nowFn();
  for (const p of [filePath, backupFilePath]) {
   for (const snap of readSessionsFileSafe(p)) {
    if (!isSessionSnapshotFresh(snap, now)) continue;
    const gid = String(snap.guildId);
    const prev = sessions.get(gid);
    if (!prev || (Number(snap.savedAt) || 0) >= (Number(prev.savedAt) || 0)) {
     sessions.set(gid, snap);
    }
   }
  }
 }

 function writeToDiskSync() {
  if (writeTimer) {
   clearTimeout(writeTimer);
   writeTimer = null;
  }
  const now = nowFn();
  for (const [gid, snap] of sessions) {
   if (!isSessionSnapshotFresh(snap, now)) sessions.delete(gid);
  }
  if (sessions.size === 0) {
   unlinkSafe(filePath);
   unlinkSafe(backupFilePath);
   return;
  }
  const payloadStr = JSON.stringify({
   v: 1,
   updatedAt: now,
   sessions: Object.fromEntries(sessions.entries()),
  });
  writeAtomicJsonSafe(filePath, payloadStr);
  writeAtomicJsonSafe(backupFilePath, payloadStr);
 }

 function scheduleWrite(delayMs = 500) {
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
   if (!deleted && !existsSync(filePath || '') && !existsSync(backupFilePath || '')) return;
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
