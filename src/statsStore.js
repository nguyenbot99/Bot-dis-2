import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EmbedBuilder } from 'discord.js';
import { resolveHumanRequester } from './access.js';
import { cleanText, safeHttpUrl } from './playerGui.js';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_STATS_FILE = resolve(PROJECT_ROOT, '.runtime-stats.json');
export const DEFAULT_TMP_STATS_FILE = join(tmpdir(), 'bot-dis-2-stats.json');
export const MAX_STAT_TRACKS = 50;
export const MAX_STAT_USERS = 40;

function deriveStatsKey(secret) {
 const clean = String(secret ?? '').trim();
 if (!clean) return null;
 return createHash('sha256').update(`bot-dis-2-stats-v1:${clean}`).digest();
}

export function sealStatsPayload(statsObj, secret) {
 const key = deriveStatsKey(secret);
 if (!key || !statsObj || typeof statsObj !== 'object') return null;
 const iv = randomBytes(12);
 const cipher = createCipheriv('aes-256-gcm', key, iv);
 const plaintext = Buffer.from(JSON.stringify({ v: 1, stats: statsObj }), 'utf8');
 const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
 const tag = cipher.getAuthTag();
 return `${iv.toString('base64url')}.${tag.toString('base64url')}.${encrypted.toString('base64url')}`;
}

export function openStatsPayload(seal, secret) {
 const key = deriveStatsKey(secret);
 if (!key || typeof seal !== 'string') return null;
 const parts = seal.split('.');
 if (parts.length !== 3) return null;
 try {
  const iv = Buffer.from(parts[0], 'base64url');
  const tag = Buffer.from(parts[1], 'base64url');
  const data = Buffer.from(parts[2], 'base64url');
  if (iv.length !== 12 || tag.length !== 16) return null;
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  const parsed = JSON.parse(plain);
  return parsed?.v === 1 && parsed.stats && typeof parsed.stats === 'object' ? parsed.stats : null;
 } catch {
  return null;
 }
}

function formatTotalHoursMinutes(ms) {
 const totalMin = Math.max(0, Math.floor((Number(ms) || 0) / 60000));
 const hours = Math.floor(totalMin / 60);
 const mins = totalMin % 60;
 if (hours <= 0) return `${mins} phút`;
 return mins > 0 ? `${hours} giờ ${mins} phút` : `${hours} giờ`;
}

export function createStatsStore({
 filePath,
 primaryFile,
 backupFilePath,
 backupFile,
} = {}) {
 const resolvedPrimary = filePath ?? primaryFile ?? DEFAULT_STATS_FILE;
 const resolvedBackup = backupFilePath ?? backupFile ?? DEFAULT_TMP_STATS_FILE;

 let totalPlays = 0;
 let totalListenMs = 0;
 const tracks = new Map(); // normUrl -> { title, author, url, plays, lastAt }
 const users = new Map();  // userId -> { plays, listenMs, topTracks: { [normUrl]: { title, url, plays } }, lastAt }

 function loadRaw(target) {
  try {
   if (!target || !existsSync(target)) return null;
   const parsed = JSON.parse(readFileSync(target, 'utf8'));
   return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
   return null;
  }
 }

 function ingestRaw(raw) {
  if (!raw || typeof raw !== 'object') return false;
  let changed = false;
  if (Number(raw.totalPlays) > totalPlays) {
   totalPlays = Math.floor(Number(raw.totalPlays));
   changed = true;
  }
  if (Number(raw.totalListenMs) > totalListenMs) {
   totalListenMs = Math.floor(Number(raw.totalListenMs));
   changed = true;
  }
  if (raw.tracks && typeof raw.tracks === 'object') {
   for (const [k, v] of Object.entries(raw.tracks)) {
    if (!v || typeof v !== 'object') continue;
    const url = safeHttpUrl(v.url || k);
    if (!url) continue;
    const norm = url.toLowerCase();
    const prev = tracks.get(norm);
    const plays = Math.max(1, Math.floor(Number(v.plays) || 1));
    if (!prev || plays > prev.plays) {
     tracks.set(norm, {
      title: cleanText(v.title ?? 'Không rõ tiêu đề', 95),
      author: cleanText(v.author ?? 'Nghệ sĩ', 45),
      url,
      plays,
      lastAt: Number(v.lastAt) || Date.now(),
     });
     changed = true;
    }
   }
  }
  if (raw.users && typeof raw.users === 'object') {
   for (const [uid, u] of Object.entries(raw.users)) {
    if (!/^\d{15,22}$/.test(uid) || !u || typeof u !== 'object') continue;
    const prev = users.get(uid);
    const plays = Math.max(1, Math.floor(Number(u.plays) || 1));
    const listenMs = Math.max(0, Math.floor(Number(u.listenMs) || 0));
    if (!prev || plays > prev.plays) {
     users.set(uid, {
      plays,
      listenMs,
      lastAt: Number(u.lastAt) || Date.now(),
     });
     changed = true;
    }
   }
  }
  pruneMaps();
  return changed;
 }

 function pruneMaps() {
  if (tracks.size > MAX_STAT_TRACKS) {
   const sorted = [...tracks.entries()].sort((a, b) => b[1].plays - a[1].plays || b[1].lastAt - a[1].lastAt);
   tracks.clear();
   for (const [k, v] of sorted.slice(0, MAX_STAT_TRACKS)) tracks.set(k, v);
  }
  if (users.size > MAX_STAT_USERS) {
   const sorted = [...users.entries()].sort((a, b) => b[1].plays - a[1].plays || b[1].lastAt - a[1].lastAt);
   users.clear();
   for (const [k, v] of sorted.slice(0, MAX_STAT_USERS)) users.set(k, v);
  }
 }

 ingestRaw(loadRaw(resolvedPrimary));
 ingestRaw(loadRaw(resolvedBackup));

 function toPlainObject({ cloudCap = false } = {}) {
  const trackEntries = [...tracks.entries()]
   .sort((a, b) => b[1].plays - a[1].plays || b[1].lastAt - a[1].lastAt)
   .slice(0, cloudCap ? 25 : MAX_STAT_TRACKS);
  const userEntries = [...users.entries()]
   .sort((a, b) => b[1].plays - a[1].plays || b[1].lastAt - a[1].lastAt)
   .slice(0, cloudCap ? 20 : MAX_STAT_USERS);
  return {
   totalPlays,
   totalListenMs,
   tracks: Object.fromEntries(trackEntries),
   users: Object.fromEntries(userEntries),
  };
 }

 function persistToDisk() {
  const payload = JSON.stringify(toPlainObject());
  for (const target of new Set([resolvedPrimary, resolvedBackup].filter(Boolean))) {
   try {
    const tmp = `${target}.tmp`;
    writeFileSync(tmp, payload, 'utf8');
    renameSync(tmp, target);
   } catch {}
  }
 }

 function recordTrackPlay(track) {
  if (!track || typeof track !== 'object') return;
  const rawDur = Number(track.duration ?? 0);
  const durationMs = rawDur > 0 ? (rawDur > 1000 ? rawDur : rawDur * 1000) : 180000;
  const cappedDur = Math.min(durationMs, 3600000);

  totalPlays += 1;
  totalListenMs += cappedDur;

  const validUrl = safeHttpUrl(track.url);
  if (validUrl) {
   const norm = validUrl.toLowerCase();
   const existing = tracks.get(norm);
   tracks.set(norm, {
    title: cleanText(track.title ?? existing?.title ?? 'Không rõ tiêu đề', 95),
    author: cleanText(track.metadata?.author ?? existing?.author ?? 'Nghệ sĩ', 45),
    url: validUrl,
    plays: (existing?.plays ?? 0) + 1,
    lastAt: Date.now(),
   });
  }

  const humanUid = resolveHumanRequester(track.requestedBy);
  if (humanUid) {
   const prevU = users.get(humanUid);
   users.set(humanUid, {
    plays: (prevU?.plays ?? 0) + 1,
    listenMs: (prevU?.listenMs ?? 0) + cappedDur,
    lastAt: Date.now(),
   });
  }

  pruneMaps();
  persistToDisk();
 }

 function getSummary(userId = null) {
  const topTracks = [...tracks.values()]
   .sort((a, b) => b.plays - a.plays || b.lastAt - a.lastAt)
   .slice(0, 10);
  const topDjs = [...users.entries()]
   .map(([uid, info]) => ({ userId: uid, ...info }))
   .sort((a, b) => b.plays - a.plays || b.listenMs - a.listenMs)
   .slice(0, 10);
  const me = userId && users.has(String(userId))
   ? {
      userId: String(userId),
      ...users.get(String(userId)),
      rank: [...users.entries()]
       .sort((a, b) => b[1].plays - a[1].plays || b[1].listenMs - a[1].listenMs)
       .findIndex(([uid]) => uid === String(userId)) + 1,
     }
   : null;
  return { totalPlays, totalListenMs, topTracks, topDjs, me };
 }

 function exportSeal(secret) {
  if (totalPlays <= 0) return null;
  return sealStatsPayload(toPlainObject({ cloudCap: true }), secret);
 }

 function importPlainStats(opened) {
  if (!opened || typeof opened !== 'object') return false;
  const changed = ingestRaw(opened);
  if (changed) persistToDisk();
  return changed;
 }

 function importSeal(seal, secret) {
  const opened = openStatsPayload(seal, secret);
  if (!opened) return false;
  return importPlainStats(opened);
 }

 return {
  recordTrackPlay,
  getSummary,
  exportSeal,
  importSeal,
  importPlainStats,
 };
}

export function buildStatsEmbed(summary, { scope = 'server', discordUser = null, botUser = null } = {}) {
 const botAvatar = botUser?.displayAvatarURL?.({ size: 128 }) ?? undefined;
 const userAvatar = discordUser?.displayAvatarURL?.({ size: 128 }) ?? botAvatar;

 if (scope === 'me') {
  const name = cleanText(discordUser?.globalName || discordUser?.username || 'Bạn', 40);
  const me = summary?.me;
  const desc = !me
   ? 'Bạn chưa yêu cầu bài hát nào được ghi nhận trên máy chủ này.\n💡 Hãy vào kênh thoại và gõ `/play` hoặc `/radio` để bắt đầu lên hạng DJ!'
   : [
      `🏅 **Hạng DJ trên máy chủ:** **#${me.rank}**`,
      `🎵 **Số bài bạn đã mở:** **${me.plays} bài**`,
      `⏳ **Tổng thời lượng đóng góp:** **${formatTotalHoursMinutes(me.listenMs)}**`,
     ].join('\n');

  return new EmbedBuilder()
   .setColor(0xf59e0b)
   .setAuthor({
    name: `🎧 Hồ Sơ Gu Âm Nhạc Cá Nhân • ${name}`,
    ...(userAvatar ? { iconURL: userAvatar } : {}),
   })
   .setDescription(desc)
   .setFooter({ text: 'Dùng /stats scope:server để xem Bảng Vàng toàn máy chủ' })
   .setTimestamp();
 }

 const medals = ['🥇', '🥈', '🥉'];
 const tracksBlock = summary.topTracks.length === 0
  ? 'Chưa có bài hát nào được phát.'
  : summary.topTracks
     .slice(0, 8)
     .map((t, idx) => {
      const prefix = medals[idx] ?? `\`#${idx + 1}\``;
      const link = t.url ? `[${cleanText(t.title, 52)}](${t.url})` : cleanText(t.title, 52);
      return `${prefix} ${link} — **${t.plays}** lần`;
     })
     .join('\n');

 const djsBlock = summary.topDjs.length === 0
  ? 'Chưa có dữ liệu DJ.'
  : summary.topDjs
     .slice(0, 5)
     .map((u, idx) => {
      const prefix = medals[idx] ?? `\`#${idx + 1}\``;
      return `${prefix} <@${u.userId}> — **${u.plays} bài** (*${formatTotalHoursMinutes(u.listenMs)}*)`;
     })
     .join('\n');

 return new EmbedBuilder()
  .setColor(0x8b5cf6)
  .setAuthor({
   name: `${cleanText(botUser?.username ?? 'Music Bot', 35)} • Bảng Vàng Âm Nhạc (Server Wrapped)`,
   ...(botAvatar ? { iconURL: botAvatar } : {}),
  })
  .setDescription(
   `📊 Tổng cộng cả máy chủ đã thưởng thức **${summary.totalPlays} lượt phát** (~ **${formatTotalHoursMinutes(summary.totalListenMs)}** âm nhạc)!`,
  )
  .addFields(
   { name: '🔥 Top Bài Hát Được Nghe Nhiều Nhất', value: tracksBlock },
   { name: '👑 Top DJ Chăm Mở Nhạc Nhất Phòng', value: djsBlock },
  )
  .setFooter({ text: 'Tự động sao lưu đám mây • Xem riêng của bạn: /stats scope:me' })
  .setTimestamp();
}
