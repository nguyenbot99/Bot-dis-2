import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EmbedBuilder } from 'discord.js';
import { cleanText, formatDuration, safeHttpUrl } from './playerGui.js';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_FAVORITES_FILE = resolve(PROJECT_ROOT, '.runtime-favorites.json');
export const DEFAULT_TMP_FAVORITES_FILE = join(tmpdir(), 'bot-dis-2-favorites.json');
export const MAX_FAVORITES_PER_USER = 25;
export const MAX_FAVORITE_USERS = 50;

function normalizeFavTrack(track) {
 if (!track || typeof track !== 'object') return null;
 const url = safeHttpUrl(track.url);
 if (!url) return null;
 const rawDur = Number(track.duration ?? 0);
 const duration = rawDur > 0 ? (rawDur > 1000 ? rawDur : rawDur * 1000) : 0;
 return {
  title: cleanText(track.title ?? 'Không rõ tiêu đề', 110),
  url,
  duration,
  thumbnail: safeHttpUrl(track.thumbnail) ?? undefined,
  author: cleanText(track.author ?? track.metadata?.author ?? 'Nghệ sĩ', 60),
  source: String(track.source ?? 'soundcloud').slice(0, 24),
  savedAt: Number(track.savedAt) || Date.now(),
 };
}

function deriveFavKey(secret) {
 const clean = String(secret ?? '').trim();
 if (!clean) return null;
 return createHash('sha256').update(`bot-dis-2-favorites-v1:${clean}`).digest();
}

export function sealFavoritesPayload(usersObj, secret) {
 const key = deriveFavKey(secret);
 if (!key || !usersObj || typeof usersObj !== 'object') return null;
 const iv = randomBytes(12);
 const cipher = createCipheriv('aes-256-gcm', key, iv);
 const plaintext = Buffer.from(JSON.stringify({ v: 1, users: usersObj }), 'utf8');
 const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
 const tag = cipher.getAuthTag();
 return `${iv.toString('base64url')}.${tag.toString('base64url')}.${encrypted.toString('base64url')}`;
}

export function openFavoritesPayload(seal, secret) {
 const key = deriveFavKey(secret);
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
  return parsed?.users && typeof parsed.users === 'object' ? parsed.users : null;
 } catch {
  return null;
 }
}

export function createFavoritesStore({
 filePath,
 primaryFile,
 backupFilePath,
 backupFile,
 onChanged = null,
} = {}) {
 const resolvedPrimary = filePath ?? primaryFile ?? DEFAULT_FAVORITES_FILE;
 const resolvedBackup = backupFilePath ?? backupFile ?? DEFAULT_TMP_FAVORITES_FILE;
 const users = new Map(); // userId -> FavTrack[]

 function loadFromPath(target) {
  try {
   if (!target || !existsSync(target)) return null;
   const parsed = JSON.parse(readFileSync(target, 'utf8'));
   return parsed?.users && typeof parsed.users === 'object' ? parsed.users : null;
  } catch {
   return null;
  }
 }

 function ingestUsersObject(rawUsers) {
  if (!rawUsers || typeof rawUsers !== 'object') return;
  for (const [uid, rawList] of Object.entries(rawUsers)) {
   if (!/^\d{15,22}$/.test(uid) || !Array.isArray(rawList)) continue;
   const existing = users.get(uid) ?? [];
   const byUrl = new Map(existing.map(item => [item.url.toLowerCase(), item]));
   for (const rawItem of rawList) {
    const clean = normalizeFavTrack(rawItem);
    if (clean && !byUrl.has(clean.url.toLowerCase())) {
     byUrl.set(clean.url.toLowerCase(), clean);
    }
   }
   const merged = Array.from(byUrl.values()).slice(0, MAX_FAVORITES_PER_USER);
   if (merged.length > 0) {
    users.set(uid, merged);
   }
   if (users.size >= MAX_FAVORITE_USERS) break;
  }
 }

 ingestUsersObject(loadFromPath(resolvedPrimary));
 ingestUsersObject(loadFromPath(resolvedBackup));

 function toPlainUsers() {
  const out = {};
  for (const [uid, list] of users.entries()) {
   if (list.length > 0) out[uid] = list;
  }
  return out;
 }

 function persistToDisk() {
  const payload = JSON.stringify({ updatedAt: Date.now(), users: toPlainUsers() });
  for (const target of new Set([resolvedPrimary, resolvedBackup].filter(Boolean))) {
   try {
    const tmp = `${target}.tmp`;
    writeFileSync(tmp, payload, 'utf8');
    renameSync(tmp, target);
   } catch {}
  }
  onChanged?.();
 }

 function getList(userId) {
  const list = users.get(String(userId ?? '')) ?? [];
  return list.map(t => ({ ...t }));
 }

 function addTrack(userId, rawTrack) {
  const uid = String(userId ?? '').trim();
  const clean = normalizeFavTrack(rawTrack);
  if (!uid || !clean) throw new Error('Không thể lưu bài hát này vào Tủ nhạc Yêu thích.');

  const list = users.get(uid) ?? [];
  const dupIdx = list.findIndex(t => t.url.toLowerCase() === clean.url.toLowerCase());
  if (dupIdx !== -1) {
   const copy = [...list];
   const [existing] = copy.splice(dupIdx, 1);
   const reordered = [existing, ...copy];
   users.set(uid, reordered);
   persistToDisk();
   return { added: false, track: existing, list: getList(uid), total: reordered.length };
  }
  if (list.length >= MAX_FAVORITES_PER_USER) {
   throw new Error(`Tủ nhạc Yêu thích của bạn đã đầy (${MAX_FAVORITES_PER_USER}/${MAX_FAVORITES_PER_USER} bài). Dùng \`/fav action:remove\` để xóa bớt.`);
  }
  if (!users.has(uid) && users.size >= MAX_FAVORITE_USERS) {
   const oldestUid = users.keys().next().value;
   if (oldestUid) users.delete(oldestUid);
  }
  const next = [clean, ...list];
  users.set(uid, next);
  persistToDisk();
  return { added: true, track: clean, list: getList(uid), total: next.length };
 }

 function removeAt(userId, position1Based) {
  const uid = String(userId ?? '').trim();
  const list = users.get(uid) ?? [];
  const idx = Number(position1Based) - 1;
  if (!Number.isInteger(idx) || idx < 0 || idx >= list.length) {
   throw new Error('Không có bài hát nào ở vị trí này trong Tủ nhạc Yêu thích của bạn.');
  }
  const [removed] = list.splice(idx, 1);
  if (list.length === 0) users.delete(uid);
  else users.set(uid, list);
  persistToDisk();
  return { removed, list: getList(uid) };
 }

 function clearUser(userId) {
  const uid = String(userId ?? '').trim();
  const prevCount = (users.get(uid) ?? []).length;
  users.delete(uid);
  if (prevCount > 0) persistToDisk();
  return prevCount;
 }

 function exportSeal(secret) {
  const plain = toPlainUsers();
  const keys = Object.keys(plain);
  if (keys.length === 0) return null;
  const capped = {};
  for (const uid of keys.slice(-20)) {
   capped[uid] = plain[uid];
  }
  return sealFavoritesPayload(capped, secret);
 }

 function importPlainUsers(opened) {
  if (!opened || typeof opened !== 'object') return false;
  const before = JSON.stringify(toPlainUsers());
  ingestUsersObject(opened);
  const after = JSON.stringify(toPlainUsers());
  if (before !== after) persistToDisk();
  return true;
 }

 function importSeal(seal, secret) {
  const opened = openFavoritesPayload(seal, secret);
  if (!opened) return false;
  return importPlainUsers(opened);
 }

 return {
  getList,
  addTrack,
  removeAt,
  clearUser,
  exportSeal,
  importSeal,
  importPlainUsers,
 };
}

export function buildFavoritesEmbed(discordUser, list = [], botUser = null) {
 const displayName = cleanText(discordUser?.globalName || discordUser?.username || 'Bạn', 40);
 const avatar = discordUser?.displayAvatarURL?.({ size: 128 }) ?? undefined;
 const botAvatar = botUser?.displayAvatarURL?.({ size: 128 }) ?? undefined;

 const desc = list.length === 0
  ? 'Tủ nhạc Yêu thích của bạn đang trống.\n💡 Hãy bấm mục **❤️ Lưu vào Tủ nhạc Yêu thích** trên khung nhạc hoặc gõ `/fav action:add` khi gặp bài hát ưng ý!'
  : list
     .map((t, idx) => {
      const dur = formatDuration(t.duration);
      const titleLink = t.url ? `[${cleanText(t.title, 62)}](${t.url})` : cleanText(t.title, 62);
      return `\`${String(idx + 1).padStart(2, '0')}.\` ${titleLink} — *${cleanText(t.author, 28)}* (\`${dur}\`)`;
     })
     .join('\n');

 return new EmbedBuilder()
  .setColor(0xec4899)
  .setAuthor({
   name: `❤️ Tủ Nhạc Yêu Thích • ${displayName}`,
   ...(avatar ? { iconURL: avatar } : botAvatar ? { iconURL: botAvatar } : {}),
  })
  .setDescription(desc)
  .setFooter({
   text: `${list.length}/${MAX_FAVORITES_PER_USER} bài đã lưu • Dùng /fav action:play hoặc shuffle để phát toàn bộ`,
  })
  .setTimestamp();
}
