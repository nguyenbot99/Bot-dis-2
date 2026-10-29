import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EmbedBuilder } from 'discord.js';
import { isBotOwner } from './access.js';
import { cleanText, formatDuration, safeHttpUrl } from './playerGui.js';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_MIXTAPES_FILE = resolve(PROJECT_ROOT, '.runtime-mixtapes.json');
export const DEFAULT_TMP_MIXTAPES_FILE = join(tmpdir(), 'bot-dis-2-mixtapes.json');
export const MAX_MIXTAPES = 5;
export const MAX_MIXTAPE_TRACKS = 20;

export function normalizeMixtapeSlug(rawName) {
 return String(rawName ?? '')
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .replace(/[đĐ]/g, 'd')
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '')
  .slice(0, 45);
}

function deriveMixtapeKey(secret) {
 const clean = String(secret ?? '').trim();
 if (!clean) return null;
 return createHash('sha256').update(`bot-dis-2-mixtapes-v1:${clean}`).digest();
}

export function sealMixtapesPayload(plainObj, secret) {
 const key = deriveMixtapeKey(secret);
 if (!key || !plainObj || typeof plainObj !== 'object') return null;
 const iv = randomBytes(12);
 const cipher = createCipheriv('aes-256-gcm', key, iv);
 const plaintext = Buffer.from(JSON.stringify({ v: 1, mixtapes: plainObj }), 'utf8');
 const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
 const tag = cipher.getAuthTag();
 return `${iv.toString('base64url')}.${tag.toString('base64url')}.${encrypted.toString('base64url')}`;
}

export function openMixtapesPayload(seal, secret) {
 const key = deriveMixtapeKey(secret);
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
  return parsed?.v === 1 && parsed.mixtapes && typeof parsed.mixtapes === 'object' ? parsed.mixtapes : null;
 } catch {
  return null;
 }
}

function sanitizeMixtapeTrack(track, fallbackUserId = null) {
 if (!track || typeof track !== 'object') return null;
 const url = safeHttpUrl(track.url);
 if (!url) return null;
 const rawDur = Number(track.duration ?? 0);
 const duration = rawDur > 0 ? (rawDur > 1000 ? rawDur : rawDur * 1000) : 0;
 const addedByRaw = String(track.addedBy ?? track.requestedBy ?? fallbackUserId ?? '').trim();
 const addedBy = /^\d{15,22}$/.test(addedByRaw) ? addedByRaw : null;
 return {
  id: cleanText(String(track.id ?? url), 80),
  title: cleanText(track.title ?? 'Không rõ tiêu đề', 80),
  author: cleanText(track.author ?? track.metadata?.author ?? 'Nghệ sĩ', 40),
  url,
  duration,
  thumbnail: safeHttpUrl(track.thumbnail) ?? null,
  source: cleanText(track.source || 'soundcloud', 20),
  addedBy,
 };
}

export function createMixtapeStore({
 filePath = DEFAULT_MIXTAPES_FILE,
 backupFilePath = DEFAULT_TMP_MIXTAPES_FILE,
} = {}) {
 const mixtapes = new Map(); // slug -> { slug, name, createdBy, updatedAt, tracks: [] }

 function loadRaw(target) {
  try {
   if (!target || !existsSync(target)) return null;
   const parsed = JSON.parse(readFileSync(target, 'utf8'));
   return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
   return null;
  }
 }

 function ingestPlain(rawObj) {
  if (!rawObj || typeof rawObj !== 'object') return false;
  let changed = false;
  for (const [k, item] of Object.entries(rawObj)) {
   if (!item || typeof item !== 'object') continue;
   const slug = normalizeMixtapeSlug(item.slug || item.name || k);
   if (!slug) continue;
   const existing = mixtapes.get(slug);
   const incomingAt = Number(item.updatedAt) || 0;
   if (existing && existing.updatedAt >= incomingAt && existing.tracks.length >= (item.tracks?.length ?? 0)) {
    continue;
   }
   const tracks = (Array.isArray(item.tracks) ? item.tracks : [])
    .map(t => sanitizeMixtapeTrack(t))
    .filter(Boolean)
    .slice(0, MAX_MIXTAPE_TRACKS);
   if (tracks.length === 0) continue;
   const creatorRaw = String(item.createdBy ?? '').trim();
   mixtapes.set(slug, {
    slug,
    name: cleanText(item.name || slug, 45),
    createdBy: /^\d{15,22}$/.test(creatorRaw) ? creatorRaw : null,
    updatedAt: incomingAt || Date.now(),
    tracks,
   });
   changed = true;
  }
  if (mixtapes.size > MAX_MIXTAPES) {
   const sorted = [...mixtapes.entries()].sort((a, b) => b[1].updatedAt - a[1].updatedAt);
   mixtapes.clear();
   for (const [s, v] of sorted.slice(0, MAX_MIXTAPES)) mixtapes.set(s, v);
  }
  return changed;
 }

 ingestPlain(loadRaw(filePath));
 ingestPlain(loadRaw(backupFilePath));

 function toPlainObject() {
  return Object.fromEntries(mixtapes.entries());
 }

 function persist() {
  const payload = JSON.stringify(toPlainObject());
  for (const target of new Set([filePath, backupFilePath].filter(Boolean))) {
   try {
    const tmp = `${target}.tmp`;
    writeFileSync(tmp, payload, 'utf8');
    renameSync(tmp, target);
   } catch {}
  }
 }

 function listMixtapes() {
  return [...mixtapes.values()].sort((a, b) => b.updatedAt - a.updatedAt);
 }

 function getMixtape(rawName) {
  const slug = normalizeMixtapeSlug(rawName);
  if (!slug) return null;
  return mixtapes.get(slug) ?? null;
 }

 function addTrack(rawName, rawTrack, userId) {
  const cleanName = cleanText(String(rawName ?? '').trim(), 45);
  const slug = normalizeMixtapeSlug(cleanName);
  if (!slug || cleanName.length < 2) {
   throw new Error('Tên Tủ nhạc chung không hợp lệ (cần từ 2 đến 45 ký tự, ví dụ: `Nhạc Chiến Rank`).');
  }
  const item = sanitizeMixtapeTrack(rawTrack, userId);
  if (!item) {
   throw new Error('Bài hát không có đường dẫn hợp lệ để lưu vào Tủ nhạc chung.');
  }

  let mix = mixtapes.get(slug);
  let createdNew = false;
  if (!mix) {
   if (mixtapes.size >= MAX_MIXTAPES) {
    throw new Error(`Tủ nhạc chung của máy chủ đã đạt tối đa ${MAX_MIXTAPES} chủ đề — hãy thêm vào tủ sẵn có hoặc xóa bớt tủ cũ nhé!`);
   }
   const uidStr = String(userId ?? '').trim();
   mix = {
    slug,
    name: cleanName,
    createdBy: /^\d{15,22}$/.test(uidStr) ? uidStr : null,
    updatedAt: Date.now(),
    tracks: [],
   };
   mixtapes.set(slug, mix);
   createdNew = true;
  }

  const normUrl = item.url.toLowerCase();
  const dupIdx = mix.tracks.findIndex(t => t.url.toLowerCase() === normUrl);
  const added = dupIdx === -1;
  if (dupIdx !== -1) {
   mix.tracks.splice(dupIdx, 1);
  } else if (mix.tracks.length >= MAX_MIXTAPE_TRACKS) {
   throw new Error(`Tủ nhạc chung "${mix.name}" đã đầy ${MAX_MIXTAPE_TRACKS}/${MAX_MIXTAPE_TRACKS} bài.`);
  }
  mix.tracks.push(item);
  mix.updatedAt = Date.now();
  persist();
  return { mixtape: mix, track: item, added, createdNew };
 }

 function removeTrackAt(rawName, pos1Based, actorUserId, env = process.env) {
  const mix = getMixtape(rawName);
  if (!mix) throw new Error('Không tìm thấy Tủ nhạc chung mang tên này (gõ `/mixtape action:list` để xem danh sách).');
  const idx = Number(pos1Based) - 1;
  if (!Number.isInteger(idx) || idx < 0 || idx >= mix.tracks.length) {
   throw new Error(`Vị trí cần xóa không hợp lệ (Tủ "${mix.name}" hiện có ${mix.tracks.length} bài).`);
  }
  const target = mix.tracks[idx];
  const actor = String(actorUserId ?? '');
  if (!isBotOwner(actor, env) && actor !== mix.createdBy && actor !== target.addedBy) {
   throw new Error('Chỉ người đã góp bài này, người tạo Tủ nhạc hoặc Chủ bot mới có quyền xóa bài khỏi Tủ chung.');
  }
  const [removed] = mix.tracks.splice(idx, 1);
  mix.updatedAt = Date.now();
  if (mix.tracks.length === 0) mixtapes.delete(mix.slug);
  persist();
  return { removed, mixtape: mixtapes.get(mix.slug) ?? null };
 }

 function deleteMixtape(rawName, actorUserId, env = process.env) {
  const mix = getMixtape(rawName);
  if (!mix) throw new Error('Không tìm thấy Tủ nhạc chung mang tên này.');
  const actor = String(actorUserId ?? '');
  if (!isBotOwner(actor, env) && actor !== mix.createdBy) {
   throw new Error('Chỉ người tạo Tủ nhạc này hoặc Chủ bot mới có quyền xóa toàn bộ Tủ chung.');
  }
  mixtapes.delete(mix.slug);
  persist();
  return mix;
 }

 function exportSeal(secret) {
  if (mixtapes.size === 0) return null;
  return sealMixtapesPayload(toPlainObject(), secret);
 }

 function importPlainMixtapes(opened) {
  const changed = ingestPlain(opened);
  if (changed) persist();
  return changed;
 }

 return {
  listMixtapes,
  getMixtape,
  addTrack,
  removeTrackAt,
  deleteMixtape,
  exportSeal,
  importPlainMixtapes,
 };
}

export function buildMixtapesListEmbed(list, botUser) {
 const avatarUrl = botUser?.displayAvatarURL?.({ size: 128 }) ?? undefined;
 const rows = list.map((m, idx) => {
  const ownerNote = m.createdBy ? ` • Tạo bởi <@${m.createdBy}>` : '';
  return `\`${idx + 1}.\` 📂 **${m.name}** — **${m.tracks.length}/${MAX_MIXTAPE_TRACKS}** bài${ownerNote}`;
 });

 return new EmbedBuilder()
  .setColor(0x10b981)
  .setAuthor({
   name: `${cleanText(botUser?.username ?? 'Music Bot', 35)} • Tủ Nhạc Chung Của Hội (Mixtape)`,
   ...(avatarUrl ? { iconURL: avatarUrl } : {}),
  })
  .setDescription(
   rows.length > 0
    ? rows.join('\n')
    : '*Máy chủ chưa có Tủ nhạc chung nào.*\n💡 Hãy mở nhạc rồi gõ `/mixtape action:add name:Nhạc Chiến Rank` để khai trương Tủ đầu tiên cho anh em cùng góp nhạc!',
  )
  .setFooter({ text: `Tối đa ${MAX_MIXTAPES} tủ (${MAX_MIXTAPE_TRACKS} bài/tủ) • Phát ngay: /mixtape action:play name:<tên tủ>` })
  .setTimestamp();
}

export function buildMixtapeDetailEmbed(mixtape, botUser) {
 const avatarUrl = botUser?.displayAvatarURL?.({ size: 128 }) ?? undefined;
 const rows = mixtape.tracks.map((t, idx) => {
  const who = t.addedBy ? ` • <@${t.addedBy}>` : '';
  return `\`${String(idx + 1).padStart(2, '0')}.\` [${cleanText(t.title, 54)}](${t.url}) (\`${formatDuration(t.duration)}\`)${who}`;
 });

 return new EmbedBuilder()
  .setColor(0x10b981)
  .setAuthor({
   name: `📂 Tủ Nhạc Chung: ${mixtape.name} (${mixtape.tracks.length}/${MAX_MIXTAPE_TRACKS} bài)`,
   ...(avatarUrl ? { iconURL: avatarUrl } : {}),
  })
  .setDescription(rows.join('\n') || '*Tủ nhạc đang trống.*')
  .setFooter({ text: `Gõ /mixtape action:play name:${mixtape.name} để phát toàn bộ tủ nhạc này` })
  .setTimestamp();
}
