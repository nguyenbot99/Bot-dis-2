import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import dns from 'node:dns/promises';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import {
 ActionRowBuilder,
 AttachmentBuilder,
 ButtonBuilder,
 ButtonStyle,
 ModalBuilder,
 TextInputBuilder,
 TextInputStyle,
} from 'discord.js';

export const CONTEXT_GIF_NAME = '🎞️ Đổi video sang GIF';

export const MAX_VIDEO_DOWNLOAD_BYTES = 42 * 1024 * 1024; // 42 MiB đầu vào an toàn cho container 512MB RAM
export const MAX_DISCORD_GIF_BYTES = 8 * 1024 * 1024; // 8.0 MiB đảm bảo gửi thành công 100% trên mọi Server & DM
export const MIN_DURATION_SEC = 0.5;
export const MAX_DURATION_SEC = 15;
export const DEFAULT_DURATION_SEC = 6;
export const MIN_SPEED = 0.25;
export const MAX_SPEED = 3.0;
export const MAX_OUTPUT_SPAN_SEC = 16;

const DOWNLOAD_TIMEOUT_MS = 25_000;
const FFMPEG_PROBE_TIMEOUT_MS = 8_000;
const FFMPEG_RENDER_TIMEOUT_MS = 38_000;
const USER_COOLDOWN_MS = 3_500;
const MAX_QUEUED_JOBS = 5;
const MAX_TUNE_SESSIONS = 30;
const TUNE_SESSION_TTL_MS = 20 * 60 * 1000;
const TEMP_PREFIX = 'batdon-gif-';
const SAFE_FONT_DIR = path.join(os.tmpdir(), 'batdon-gif-fonts');

const BUNDLED_FONT_SRC = fileURLToPath(new URL('./assets/fonts/MemeSans-Bold.ttf', import.meta.url));

export const GIF_QUALITY_PRESETS = Object.freeze({
 balanced: {
  key: 'balanced',
  label: 'Rõ nét cân bằng',
  maxWidth: 380,
  maxHeight: 460,
  fps: 12,
  maxColors: 256,
  dither: 'bayer:bayer_scale=5',
 },
 hd: {
  key: 'hd',
  label: 'Siêu nét HD',
  maxWidth: 480,
  maxHeight: 560,
  fps: 15,
  maxColors: 256,
  dither: 'sierra2_4a',
 },
 compact: {
  key: 'compact',
  label: 'Siêu nhẹ mượt',
  maxWidth: 300,
  maxHeight: 360,
  fps: 10,
  maxColors: 192,
  dither: 'bayer:bayer_scale=3',
 },
 ultra_compact: {
  key: 'ultra_compact',
  label: 'Nén gọn tối ưu',
  maxWidth: 236,
  maxHeight: 290,
  fps: 8,
  maxColors: 128,
  dither: 'bayer:bayer_scale=2',
 },
});

export const GIF_CAPTION_STYLES = Object.freeze({
 bar: { key: 'bar', label: '⬜ Thanh trắng Meme đầu ảnh' },
 bottom: { key: 'bottom', label: '💬 Phụ đề viền đen đáy ảnh' },
 top: { key: 'top', label: '🔝 Chữ viền đen đỉnh ảnh' },
});

const VIDEO_EXT_RE = /\.(mp4|mov|webm|mkv|avi|m4v|mpeg|mpg|3gp|ts|flv|wmv|gifv|gif|webp|apng)(?:[?#]|$)/i;
const URL_IN_TEXT_RE = /https?:\/\/[^\s<>()]+/gi;

// Kiểm tra địa chỉ IPv4 / IPv6 nội bộ, loopback, link-local để chặn hoàn toàn SSRF.
export function isBlockedIpAddress(rawIp) {
 if (!rawIp || typeof rawIp !== 'string') return true;
 const ip = rawIp.trim().replace(/^\[|\]$/g, '').split('%')[0].toLowerCase();

 // IPv4-mapped IPv6 dạng dấu chấm (::ffff:127.0.0.1) hoặc dạng hex (::ffff:7f00:1) do URL parser chuẩn hóa.
 if (ip.startsWith('::ffff:')) {
  const tail = ip.slice('::ffff:'.length);
  if (net.isIP(tail) === 4) return isBlockedIpAddress(tail);
  const hexMatch = tail.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (hexMatch) {
   const hi = parseInt(hexMatch[1], 16);
   const lo = parseInt(hexMatch[2], 16);
   const v4 = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
   return isBlockedIpAddress(v4);
  }
  return true;
 }

 const version = net.isIP(ip);
 if (version === 4) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a >= 224) return true; // Multicast & Reserved
  return false;
 }

 if (version === 6) {
  if (ip === '::' || ip === '::1') return true;
  if (ip.startsWith('fc') || ip.startsWith('fd')) return true; // Unique local fc00::/7
  if (/^fe[89ab]/i.test(ip)) return true; // Link-local fe80::/10
  if (ip.startsWith('ff')) return true; // Multicast
  if (ip.startsWith('2001:db8:')) return true; // Documentation
  return false;
 }

 return true;
}

export function normalizeCandidateVideoUrl(rawUrl) {
 const trimmed = String(rawUrl ?? '').trim().replace(/^<+|>+$/g, '').trim();
 if (!trimmed) return '';
 // Link Imgur .gifv thực chất là trang bọc quanh file .mp4 cùng tên.
 if (/^https?:\/\/i\.imgur\.com\/[a-zA-Z0-9]+\.gifv(?:[?#].*)?$/i.test(trimmed)) {
  return trimmed.replace(/\.gifv(?=[?#]|$)/i, '.mp4');
 }
 return trimmed;
}

export async function assertSafePublicUrl(rawUrl, lookupFn = dns.lookup) {
 const cleaned = normalizeCandidateVideoUrl(rawUrl);
 if (!cleaned) {
  throw new Error('Hãy tải file video lên hoặc dán link video hợp lệ (.mp4, .mov, .webm).');
 }
 let parsed;
 try {
  parsed = new URL(cleaned);
 } catch {
  throw new Error('URL video không hợp lệ — hãy dán đường dẫn bắt đầu bằng https:// hoặc tải file video lên nhé!');
 }
 if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
  throw new Error('URL video chỉ hỗ trợ giao thức http:// hoặc https://.');
 }
 if (parsed.username || parsed.password) {
  throw new Error('URL video không được chứa thông tin đăng nhập nội bộ.');
 }

 const hostname = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
 if (
  !hostname
  || hostname === 'localhost'
  || hostname.endsWith('.localhost')
  || hostname.endsWith('.local')
  || hostname.endsWith('.internal')
 ) {
  throw new Error('URL không được trỏ tới địa chỉ nội bộ.');
 }

 if (net.isIP(hostname)) {
  if (isBlockedIpAddress(hostname)) {
   throw new Error('URL không được trỏ tới địa chỉ mạng nội bộ.');
  }
  return parsed.toString();
 }

 let records;
 try {
  records = await lookupFn(hostname, { all: true, verbatim: true });
 } catch {
  throw new Error('Không thể kết nối tới tên miền chứa video này — hãy kiểm tra lại link nhé!');
 }
 const list = Array.isArray(records) ? records : (records ? [records] : []);
 if (list.length === 0 || list.some(r => isBlockedIpAddress(r?.address))) {
  throw new Error('URL video bị từ chối vì trỏ tới địa chỉ mạng nội bộ không an toàn.');
 }
 return parsed.toString();
}

// Đọc mốc thời gian bắt đầu (hỗ trợ "0", "3.5", "5s", "01:15", "1:05.5", "00:01:20").
export function parseGifTimestamp(raw) {
 const txt = String(raw ?? '').trim().replace(/s$/i, '').trim();
 if (!txt) return 0;
 if (/^\d+(?:\.\d+)?$/.test(txt)) {
  const sec = Number(txt);
  if (!Number.isFinite(sec) || sec < 0 || sec > 7200) {
   throw new Error('Thời gian bắt đầu phải nằm trong khoảng từ 0s đến 7200s (2 giờ).');
  }
  return Math.round(sec * 100) / 100;
 }
 const parts = txt.split(':');
 if (parts.length >= 2 && parts.length <= 3 && parts.every(p => /^\d+(?:\.\d+)?$/.test(p.trim()))) {
  const nums = parts.map(p => Number(p.trim()));
  const sec = nums.length === 3
   ? nums[0] * 3600 + nums[1] * 60 + nums[2]
   : nums[0] * 60 + nums[1];
  if (!Number.isFinite(sec) || sec < 0 || sec > 7200) {
   throw new Error('Thời gian bắt đầu phải nằm trong khoảng từ 0:00 đến 2:00:00.');
  }
  return Math.round(sec * 100) / 100;
 }
 throw new Error('Thời gian bắt đầu không hợp lệ — hãy nhập số giây (VD: 3.5) hoặc phút:giây (VD: 01:15).');
}

// Đọc chuỗi "Bắt đầu - Độ dài" trong hộp thoại chỉnh sửa nhanh (VD: "0 - 6", "1:05 - 5", hoặc chỉ "4").
export function parseGifTimingRange(raw, fallbackStart = 0, fallbackDuration = DEFAULT_DURATION_SEC) {
 const txt = String(raw ?? '').trim();
 if (!txt) return { startSec: fallbackStart, durationSec: fallbackDuration };
 const sep = txt.match(/^(.+?)\s*(?:-|–|—|,|\s+tới\s+|\s+đến\s+)\s*(.+)$/i);
 if (!sep) {
  return { startSec: parseGifTimestamp(txt), durationSec: fallbackDuration };
 }
 const startSec = parseGifTimestamp(sep[1]);
 const durRaw = Number(String(sep[2]).trim().replace(/s$/i, ''));
 if (!Number.isFinite(durRaw) || durRaw < MIN_DURATION_SEC || durRaw > MAX_DURATION_SEC) {
  throw new Error(`Thời lượng đoạn GIF phải từ ${MIN_DURATION_SEC}s đến ${MAX_DURATION_SEC}s (VD: 0 - 6).`);
 }
 return {
  startSec,
  durationSec: Math.round(durRaw * 100) / 100,
 };
}

export function normalizeGifOptions(raw = {}) {
 const startSec = typeof raw.startSec === 'number'
  ? Math.max(0, Math.min(7200, Math.round(raw.startSec * 100) / 100))
  : parseGifTimestamp(raw.start ?? '');

 let durationSec = raw.duration === undefined || raw.duration === null || raw.duration === ''
  ? DEFAULT_DURATION_SEC
  : Number(raw.duration);
 if (!Number.isFinite(durationSec) || durationSec < MIN_DURATION_SEC || durationSec > MAX_DURATION_SEC) {
  throw new Error(`Thời lượng cắt GIF phải từ ${MIN_DURATION_SEC} giây đến ${MAX_DURATION_SEC} giây.`);
 }
 durationSec = Math.round(durationSec * 100) / 100;

 let speed = raw.speed === undefined || raw.speed === null || raw.speed === ''
  ? 1.0
  : Number(String(raw.speed).trim().replace(/x$/i, ''));
 if (!Number.isFinite(speed) || speed < MIN_SPEED || speed > MAX_SPEED) {
  throw new Error(`Tốc độ chạy GIF phải nằm trong khoảng từ ${MIN_SPEED}x đến ${MAX_SPEED}x (VD: 0.5, 1.0, 1.5, 2.0).`);
 }
 speed = Math.round(speed * 100) / 100;

 // Chặn trường hợp quay chậm 0.25x trên đoạn 15s tạo ra GIF dài 60s làm tràn 8MB.
 let cappedBySlowMo = false;
 if (durationSec / speed > MAX_OUTPUT_SPAN_SEC) {
  durationSec = Math.max(MIN_DURATION_SEC, Math.round(MAX_OUTPUT_SPAN_SEC * speed * 100) / 100);
  cappedBySlowMo = true;
 }

 const qualityKey = GIF_QUALITY_PRESETS[raw.quality] ? raw.quality : 'balanced';
 const captionStyle = GIF_CAPTION_STYLES[raw.captionStyle] ? raw.captionStyle : 'bar';
 const caption = String(raw.caption ?? '')
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
  .trim()
  .slice(0, 140);

 return {
  startSec,
  durationSec,
  speed,
  quality: qualityKey,
  caption,
  captionStyle,
  cappedBySlowMo,
 };
}

function isLikelyVideoAttachment(att) {
 if (!att) return false;
 const ct = String(att.contentType ?? att.content_type ?? '').toLowerCase();
 const url = String(att.url ?? att.proxyURL ?? att.proxy_url ?? '');
 const name = String(att.name ?? att.filename ?? '');
 if (ct.startsWith('video/')) return true;
 if (ct === 'image/gif' || ct === 'image/webp' || ct === 'image/apng') return true;
 return VIDEO_EXT_RE.test(name) || VIDEO_EXT_RE.test(url);
}

function extractVideoCandidateFromSingleBag(bag) {
 if (!bag) return null;
 const rawAttachments = bag.attachments instanceof Map
  ? [...bag.attachments.values()]
  : (Array.isArray(bag.attachments) ? bag.attachments : []);
 for (const att of rawAttachments) {
  if (isLikelyVideoAttachment(att) && (att.url || att.proxyURL || att.proxy_url)) {
   return {
    url: normalizeCandidateVideoUrl(att.url || att.proxyURL || att.proxy_url),
    filename: att.name ?? att.filename ?? 'video.mp4',
    sizeBytes: Number(att.size) || 0,
   };
  }
 }

 const embeds = Array.isArray(bag.embeds) ? bag.embeds : [];
 for (const emb of embeds) {
  const vidUrl = emb?.video?.url || emb?.video?.proxyURL || emb?.video?.proxy_url;
  if (vidUrl) {
   return {
    url: normalizeCandidateVideoUrl(vidUrl),
    filename: 'embed-video.mp4',
    sizeBytes: 0,
   };
  }
 }

 const content = String(bag.content ?? '');
 const urls = content.match(URL_IN_TEXT_RE) ?? [];
 if (urls.length > 0) {
  const best = urls.find(u => VIDEO_EXT_RE.test(u) || /imgur\.com|tenor\.com|giphy\.com|discordapp\.(?:com|net)/i.test(u)) ?? urls[0];
  return {
   url: normalizeCandidateVideoUrl(best),
   filename: 'linked-video.mp4',
   sizeBytes: 0,
  };
 }
 return null;
}

// Trích xuất file video hoặc link video từ tin nhắn Discord (kể cả tin nhắn Chuyển tiếp / Forwarded messageSnapshots).
export function extractVideoFromMessage(message) {
 const direct = extractVideoCandidateFromSingleBag(message);
 if (direct) return direct;

 const snapshots = message?.messageSnapshots instanceof Map
  ? [...message.messageSnapshots.values()]
  : (Array.isArray(message?.messageSnapshots) ? message.messageSnapshots : []);
 for (const snap of snapshots) {
  const nested = extractVideoCandidateFromSingleBag(snap);
  if (nested) return nested;
 }

 throw new Error('Tin nhắn này không có file video đính kèm hay link video (.mp4, .mov, .webm) để đổi sang GIF.');
}

// Tính toán kích thước đầu ra chẵn, giữ nguyên tỷ lệ khung hình cho cả video ngang 16:9, vuông 1:1 và dọc TikTok 9:16.
export function computeScaledDimensions(inWidth, inHeight, preset) {
 const w = Math.max(2, Number(inWidth) || 380);
 const h = Math.max(2, Number(inHeight) || 280);
 const maxW = preset?.maxWidth ?? 380;
 const maxH = preset?.maxHeight ?? 460;
 const ratio = Math.min(1, maxW / w, maxH / h);
 const outW = Math.max(64, Math.round((w * ratio) / 2) * 2);
 const outH = Math.max(64, Math.round((h * ratio) / 2) * 2);
 return { width: outW, height: outH };
}

function escapeAssText(text) {
 return String(text ?? '')
  .replace(/\\/g, '＼')
  .replace(/\{/g, '（')
  .replace(/\}/g, '）')
  .trim();
}

function wrapCaptionLines(rawText, maxCharsPerLine = 26, maxLines = 3) {
 const manualParts = String(rawText ?? '')
  .replace(/\\n/g, '\n')
  .split(/\n+/)
  .map(s => s.trim())
  .filter(Boolean);
 const lines = [];
 for (const segment of manualParts) {
  const words = segment.split(/\s+/).filter(Boolean);
  let cur = '';
  for (const word of words) {
   if (!cur) {
    cur = word.length > maxCharsPerLine + 6 ? word.slice(0, maxCharsPerLine + 6) : word;
   } else if (cur.length + 1 + word.length <= maxCharsPerLine) {
    cur += ` ${word}`;
   } else {
    lines.push(cur);
    cur = word.length > maxCharsPerLine + 6 ? word.slice(0, maxCharsPerLine + 6) : word;
   }
  }
  if (cur) lines.push(cur);
 }
 if (lines.length <= maxLines) return lines;
 const kept = lines.slice(0, maxLines);
 kept[maxLines - 1] = `${kept[maxLines - 1].slice(0, Math.max(6, maxCharsPerLine - 1)).trimEnd()}…`;
 return kept;
}

// Tạo kịch bản phụ đề ASS cho chữ Meme Tiếng Việt (hỗ trợ Thanh trắng Meme đầu ảnh + Phụ đề viền đen trên/dưới bằng dấu "|").
export function buildMemeAssConfig({ width, height, caption, captionStyle = 'bar' }) {
 const trimmed = String(caption ?? '').trim();
 if (!trimmed) {
  return { padTop: 0, assContent: null };
 }

 const pipeIdx = trimmed.indexOf('|');
 let topRaw = '';
 let bottomRaw = '';
 if (pipeIdx >= 0) {
  topRaw = trimmed.slice(0, pipeIdx).trim();
  bottomRaw = trimmed.slice(pipeIdx + 1).trim();
 } else if (captionStyle === 'bottom') {
  bottomRaw = trimmed;
 } else {
  topRaw = trimmed;
 }

 const maxChars = Math.max(16, Math.min(32, Math.round(width / 13.2)));
 const topLines = topRaw ? wrapCaptionLines(topRaw, maxChars, 3) : [];
 const bottomLines = bottomRaw ? wrapCaptionLines(bottomRaw, maxChars, 3) : [];
 if (topLines.length === 0 && bottomLines.length === 0) {
  return { padTop: 0, assContent: null };
 }

 const useWhiteBar = topLines.length > 0 && captionStyle === 'bar';
 const barFontSize = Math.max(15, Math.min(27, Math.round(width * 0.062)));
 const subFontSize = Math.max(16, Math.min(28, Math.round(width * 0.066)));
 const lineStep = Math.round(barFontSize * 1.28);
 const padTop = useWhiteBar
  ? Math.round((topLines.length * lineStep + Math.max(18, Math.round(barFontSize * 0.85))) / 2) * 2
  : 0;
 const totalHeight = height + padTop;
 const barMarginV = useWhiteBar
  ? Math.max(8, Math.round((padTop - topLines.length * lineStep) / 2) + 2)
  : 14;
 const outlinePx = Math.max(2, Math.round(subFontSize * 0.12));

 const dialogues = [];
 if (topLines.length > 0) {
  const joinedTop = topLines.map(escapeAssText).join('\\N');
  const styleName = useWhiteBar ? 'MemeBar' : 'MemeTop';
  dialogues.push(`Dialogue: 0,0:00:00.00,0:59:59.00,${styleName},,0,0,0,,${joinedTop}`);
 }
 if (bottomLines.length > 0) {
  const joinedBottom = bottomLines.map(escapeAssText).join('\\N');
  dialogues.push(`Dialogue: 0,0:00:00.00,0:59:59.00,MemeSub,,0,0,0,,${joinedBottom}`);
 }

 const assContent = [
  '[Script Info]',
  'ScriptType: v4.00+',
  `PlayResX: ${width}`,
  `PlayResY: ${totalHeight}`,
  'WrapStyle: 2',
  'ScaledBorderAndShadow: yes',
  '',
  '[V4+ Styles]',
  'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
  `Style: MemeBar,DejaVu Sans,${barFontSize},&H00111111,&H00111111,&H00FFFFFF,&H00FFFFFF,-1,0,0,0,100,100,0,0,1,0,0,8,12,12,${barMarginV},1`,
  `Style: MemeTop,DejaVu Sans,${subFontSize},&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,${outlinePx},1,8,12,12,14,1`,
  `Style: MemeSub,DejaVu Sans,${subFontSize},&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,${outlinePx},1,2,12,12,14,1`,
  '',
  '[Events]',
  'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ...dialogues,
  '',
 ].join('\n');

 return { padTop, assContent };
}

// Giải mã thông tin luồng hình ảnh từ kết quả `ffmpeg -i`.
export function parseFfmpegProbeOutput(stderrText) {
 const text = String(stderrText ?? '');
 const videoMatch = text.match(/Stream #\d+:\d+[^\n]*?:\s*Video:\s*([^\n]+)/i);
 if (!videoMatch) {
  return { hasVideo: false, width: 0, height: 0, durationSec: null };
 }
 const videoLine = videoMatch[1];
 const dimMatch = videoLine.match(/(?:^|[,\s])(\d{2,5})x(\d{2,5})(?=[\s,\[])/);
 let width = dimMatch ? Number(dimMatch[1]) : 380;
 let height = dimMatch ? Number(dimMatch[2]) : 280;

 // Video quay dọc bằng điện thoại thường có cờ xoay +-90 / 270 độ.
 if (/rotation of -?(?:90|270)(?:\.0+)? degrees/i.test(text)) {
  [width, height] = [height, width];
 }

 let durationSec = null;
 const durMatch = text.match(/Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/i);
 if (durMatch) {
  const parsed = Number(durMatch[1]) * 3600 + Number(durMatch[2]) * 60 + Number(durMatch[3]);
  if (Number.isFinite(parsed) && parsed > 0) durationSec = parsed;
 }

 return { hasVideo: true, width, height, durationSec };
}

function extractMetaVideoUrlFromHtml(html) {
 const patterns = [
  /<meta[^>]+property=["']og:video:secure_url["'][^>]+content=["']([^"']+)["']/i,
  /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:video:secure_url["']/i,
  /<meta[^>]+property=["']og:video:url["'][^>]+content=["']([^"']+)["']/i,
  /<meta[^>]+property=["']og:video["'][^>]+content=["']([^"']+)["']/i,
  /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:video["']/i,
  /<meta[^>]+name=["']twitter:player:stream["'][^>]+content=["']([^"']+)["']/i,
 ];
 for (const re of patterns) {
  const m = String(html ?? '').match(re);
  if (m?.[1] && /^https?:\/\//i.test(m[1])) {
   return m[1].replace(/&amp;/g, '&').trim();
  }
 }
 return null;
}

function runFfmpegProcess(ffmpegPath, args, timeoutMs) {
 return new Promise((resolve, reject) => {
  const child = spawn(ffmpegPath, args, {
   stdio: ['ignore', 'ignore', 'pipe'],
   env: { ...process.env },
  });
  let stderr = '';
  let killedByTimeout = false;
  const timer = setTimeout(() => {
   killedByTimeout = true;
   try { child.kill('SIGKILL'); } catch {}
  }, timeoutMs);
  timer.unref?.();

  child.stderr.on('data', chunk => {
   if (stderr.length < 12_288) {
    stderr += chunk.toString('utf8').slice(0, 12_288 - stderr.length);
   }
  });
  child.on('error', err => {
   clearTimeout(timer);
   reject(err);
  });
  child.on('close', code => {
   clearTimeout(timer);
   if (killedByTimeout) {
    reject(new Error('Quá thời gian xử lý video — hãy thử cắt đoạn ngắn hơn (4–8 giây) nhé!'));
    return;
   }
   resolve({ code: code ?? 1, stderr });
  });
 });
}

export function buildGifTuneModal(token, session = {}) {
 const timingDefault = `${session.startSec ?? 0} - ${session.durationSec ?? DEFAULT_DURATION_SEC}`;
 return new ModalBuilder()
  .setCustomId(`gif_tune_modal:${token}`)
  .setTitle('🎞️ Chỉnh ảnh GIF & Chữ Meme')
  .addComponents(
   new ActionRowBuilder().addComponents(
    new TextInputBuilder()
     .setCustomId('gif_caption')
     .setLabel('Chữ Meme (dùng | chia Trên | Dưới)')
     .setStyle(TextInputStyle.Paragraph)
     .setRequired(false)
     .setMaxLength(140)
     .setValue(String(session.caption ?? '').slice(0, 140))
     .setPlaceholder('VD: Khi sếp gọi lúc 5h chiều | Hoặc bỏ trống nếu không chèn chữ'),
   ),
   new ActionRowBuilder().addComponents(
    new TextInputBuilder()
     .setCustomId('gif_caption_style')
     .setLabel('Kiểu chữ: bar / bottom / top')
     .setStyle(TextInputStyle.Short)
     .setRequired(false)
     .setMaxLength(12)
     .setValue(String(session.captionStyle ?? 'bar'))
     .setPlaceholder('bar = Thanh trắng đầu ảnh, bottom = Đáy ảnh, top = Đỉnh ảnh'),
   ),
   new ActionRowBuilder().addComponents(
    new TextInputBuilder()
     .setCustomId('gif_timing')
     .setLabel('Cắt giây: Bắt đầu - Độ dài (0.5–15s)')
     .setStyle(TextInputStyle.Short)
     .setRequired(false)
     .setMaxLength(28)
     .setValue(timingDefault)
     .setPlaceholder('VD: 0 - 6 hoặc 01:12 - 5'),
   ),
   new ActionRowBuilder().addComponents(
    new TextInputBuilder()
     .setCustomId('gif_speed')
     .setLabel('Tốc độ chạy GIF (0.25 đến 3.0)')
     .setStyle(TextInputStyle.Short)
     .setRequired(false)
     .setMaxLength(8)
     .setValue(String(session.speed ?? 1))
     .setPlaceholder('VD: 1.0 (chuẩn), 0.5 (quay chậm), 1.8 (tua nhanh)'),
   ),
  );
}

export function buildGifActionComponents({ token, requesterId, includeDmSave = true, includeDelete = true } = {}) {
 const buttons = [];
 if (token) {
  buttons.push(
   new ButtonBuilder()
    .setCustomId(`gif_tune:${token}`)
    .setLabel('Chèn chữ / Cắt & Tốc độ')
    .setEmoji('✍️')
    .setStyle(ButtonStyle.Primary),
  );
 }
 if (includeDmSave) {
  buttons.push(
   new ButtonBuilder()
    .setCustomId('gif_dm')
    .setLabel('Lưu về DM')
    .setEmoji('📩')
    .setStyle(ButtonStyle.Secondary),
  );
 }
 if (includeDelete && requesterId) {
  buttons.push(
   new ButtonBuilder()
    .setCustomId(`gif_del:${requesterId}`)
    .setLabel('Xóa')
    .setEmoji('🗑️')
    .setStyle(ButtonStyle.Danger),
  );
 }
 if (buttons.length === 0) return [];
 return [new ActionRowBuilder().addComponents(buttons).toJSON()];
}

export function formatGifSummaryLine(meta = {}) {
 const sizeMb = ((Number(meta.bytes) || 0) / (1024 * 1024)).toFixed(2);
 const speedTag = meta.speed && meta.speed !== 1 ? ` • ⚡ ${meta.speed}x` : '';
 const cutTag = meta.startSec > 0 ? ` • ✂️ từ ${meta.startSec}s` : '';
 const capTag = meta.caption ? ' • 💬 Meme' : '';
 const autoCompressed = meta.autoSteppedDown ? ' *(đã tự tối ưu vừa chuẩn <8MB)*' : '';
 return `🎞️ **Đã tạo ảnh GIF hoàn tất!** *(${meta.width}×${meta.height} • ${meta.fps} FPS • ${meta.outputDurationSec}s${speedTag}${cutTag}${capTag} • ${sizeMb} MB)*${autoCompressed}`;
}

export function createVideoToGifManager({ ffmpegPath, lookupFn = dns.lookup, fetchFn = globalThis.fetch } = {}) {
 if (!ffmpegPath) throw new Error('Thiếu đường dẫn ffmpeg-static cho bộ chuyển đổi GIF.');

 const userCooldowns = new Map();
 const tuneSessions = new Map();
 const waitQueue = [];
 let activeWorkers = 0;
 let fontReadyPromise = null;

 function sweepStaleTempDirsSync() {
  try {
   const tmpRoot = os.tmpdir();
   for (const entry of fs.readdirSync(tmpRoot)) {
    if (entry.startsWith(TEMP_PREFIX)) {
     fs.rmSync(path.join(tmpRoot, entry), { recursive: true, force: true });
    }
   }
  } catch {}
 }
 sweepStaleTempDirsSync();

 async function ensureSafeFontDir() {
  if (!fontReadyPromise) {
   fontReadyPromise = (async () => {
    await fsp.mkdir(SAFE_FONT_DIR, { recursive: true });
    const targetFont = path.join(SAFE_FONT_DIR, 'MemeSans-Bold.ttf');
    await fsp.copyFile(BUNDLED_FONT_SRC, targetFont);
    return SAFE_FONT_DIR;
   })().catch(err => {
    fontReadyPromise = null;
    throw err;
   });
  }
  return fontReadyPromise;
 }

 function saveTuneSession(data) {
  const now = Date.now();
  for (const [k, v] of tuneSessions) {
   if (now - v.createdAt > TUNE_SESSION_TTL_MS) tuneSessions.delete(k);
  }
  while (tuneSessions.size >= MAX_TUNE_SESSIONS) {
   const oldest = tuneSessions.keys().next().value;
   if (!oldest) break;
   tuneSessions.delete(oldest);
  }
  const token = data.token || randomBytes(5).toString('hex');
  const record = { ...data, token, createdAt: now };
  tuneSessions.set(token, record);
  return record;
 }

 function getTuneSession(token) {
  const s = tuneSessions.get(String(token ?? ''));
  if (!s) return null;
  if (Date.now() - s.createdAt > TUNE_SESSION_TTL_MS) {
   tuneSessions.delete(s.token);
   return null;
  }
  s.createdAt = Date.now();
  return s;
 }

 async function fetchWithSafeRedirects(initialUrl, maxBytes = MAX_VIDEO_DOWNLOAD_BYTES) {
  let currentUrl = await assertSafePublicUrl(initialUrl, lookupFn);
  let htmlHopUsed = false;

  for (let hop = 0; hop <= 4; hop++) {
   const res = await fetchFn(currentUrl, {
    method: 'GET',
    redirect: 'manual',
    headers: {
     'User-Agent': 'Mozilla/5.0 (compatible; BatDonDiscordBot/2.0)',
     Accept: 'video/*,image/gif,image/webp,application/octet-stream,*/*;q=0.8',
    },
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
   }).catch(err => {
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
     throw new Error('Quá thời gian tải video từ đường dẫn này — hãy thử tải file video trực tiếp lên nhé!');
    }
    throw new Error('Không thể tải được file video từ đường dẫn đã cung cấp.');
   });

   if (res.status >= 300 && res.status < 400) {
    const loc = res.headers.get('location');
    try { await res.body?.cancel?.(); } catch {}
    if (!loc || hop === 4) {
     throw new Error('Link video chuyển hướng quá nhiều lần nên không thể tải.');
    }
    const resolvedNext = new URL(loc, currentUrl).toString();
    currentUrl = await assertSafePublicUrl(resolvedNext, lookupFn);
    continue;
   }

   if (!res.ok || !res.body) {
    try { await res.body?.cancel?.(); } catch {}
    throw new Error(`Không thể tải video (máy chủ trả về mã ${res.status}) — link có thể đã hết hạn hoặc bị khóa.`);
   }

   const contentLength = Number(res.headers.get('content-length') || 0);
   if (contentLength > maxBytes) {
    try { await res.body?.cancel?.(); } catch {}
    throw new Error('Video quá lớn (vượt mức an toàn 42MB) — hãy cắt ngắn hoặc gửi clip nhẹ hơn nhé!');
   }

   const contentType = String(res.headers.get('content-type') ?? '').toLowerCase();
   // Nếu người dùng dán trang Tenor / Imgur / Giphy HTML có thẻ og:video -> tự bóc link .mp4 thật 1 lần!
   if (contentType.includes('text/html')) {
    if (htmlHopUsed) {
     try { await res.body?.cancel?.(); } catch {}
     throw new Error('Link này là trang web chứ không phải file video trực tiếp — hãy tải file video (.mp4, .mov, .webm) lên ô video hoặc chuột phải vào video trên Discord nhé!');
    }
    htmlHopUsed = true;
    const reader = res.body.getReader();
    const chunks = [];
    let readBytes = 0;
    while (readBytes < 98_304) {
     const { done, value } = await reader.read();
     if (done || !value) break;
     chunks.push(Buffer.from(value));
     readBytes += value.byteLength;
    }
    try { await reader.cancel(); } catch {}
    const html = Buffer.concat(chunks).toString('utf8');
    const metaVideo = extractMetaVideoUrlFromHtml(html);
    if (!metaVideo) {
     throw new Error('Link này là trang web chứ không phải file video trực tiếp — hãy tải file video (.mp4, .mov, .webm) lên ô video hoặc chuột phải vào video trên Discord nhé!');
    }
    currentUrl = await assertSafePublicUrl(new URL(metaVideo, currentUrl).toString(), lookupFn);
    continue;
   }

   return { response: res, finalUrl: currentUrl };
  }

  throw new Error('Không thể tải được video từ đường dẫn này.');
 }

 async function downloadToTempFile(rawUrl, destPath, maxBytes = MAX_VIDEO_DOWNLOAD_BYTES) {
  const { response } = await fetchWithSafeRedirects(rawUrl, maxBytes);
  let total = 0;
  const limiter = new Transform({
   transform(chunk, _enc, cb) {
    total += chunk.length;
    if (total > maxBytes) {
     cb(new Error('Video quá lớn (vượt mức an toàn 42MB) — hãy cắt ngắn hoặc gửi clip nhẹ hơn nhé!'));
     return;
    }
    cb(null, chunk);
   },
  });
  await pipeline(Readable.fromWeb(response.body), limiter, fs.createWriteStream(destPath));
  if (total < 64) {
   throw new Error('Tệp video tải về bị rỗng hoặc bị hỏng.');
  }
  return total;
 }

 async function downloadSmallGifBuffer(rawUrl, maxBytes = 10 * 1024 * 1024) {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), TEMP_PREFIX));
  const tmpPath = path.join(tmpDir, 'copy.gif');
  try {
   await downloadToTempFile(rawUrl, tmpPath, maxBytes);
   return await fsp.readFile(tmpPath);
  } finally {
   await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
 }

 async function renderSingleTier({
  inputPath,
  workDir,
  probe,
  opts,
  preset,
  fontsDir,
  tierIndex,
 }) {
  const { width, height } = computeScaledDimensions(probe.width, probe.height, preset);
  const { padTop, assContent } = buildMemeAssConfig({
   width,
   height,
   caption: opts.caption,
   captionStyle: opts.captionStyle,
  });

  const filterSteps = [
   `setpts=(PTS-STARTPTS)/${opts.speed}`,
   `fps=${preset.fps}`,
   `scale=${width}:${height}:flags=lanczos`,
  ];
  if (padTop > 0) {
   filterSteps.push(`pad=${width}:${height + padTop}:0:${padTop}:white`);
  }
  if (assContent) {
   const assPath = path.join(workDir, `cap-${tierIndex}.ass`);
   await fsp.writeFile(assPath, assContent, 'utf8');
   filterSteps.push(`ass=filename=${assPath}:fontsdir=${fontsDir}`);
  }
  const baseChain = filterSteps.join(',');

  const seekArgs = [];
  if (opts.startSec > 0) {
   seekArgs.push('-ss', String(opts.startSec));
  }
  seekArgs.push('-t', String(opts.durationSec));

  const palettePath = path.join(workDir, `pal-${tierIndex}.png`);
  const outputPath = path.join(workDir, `out-${tierIndex}.gif`);

  // Lượt 1: Tạo bảng màu tối ưu 256 màu riêng cho đoạn clip (chỉ tốn ~15–20MB RAM nhờ 2-pass trên ổ tạm).
  const pass1 = await runFfmpegProcess(
   ffmpegPath,
   [
    '-nostdin',
    '-hide_banner',
    '-loglevel', 'error',
    '-threads', '1',
    '-protocol_whitelist', 'file,pipe',
    ...seekArgs,
    '-i', inputPath,
    '-vf', `${baseChain},palettegen=max_colors=${preset.maxColors}:stats_mode=full`,
    '-frames:v', '1',
    '-y', palettePath,
   ],
   FFMPEG_RENDER_TIMEOUT_MS,
  );
  const palStat = await fsp.stat(palettePath).catch(() => null);
  if (pass1.code !== 0 || !palStat || palStat.size === 0) {
   throw new Error('Không thể trích xuất khung hình tại mốc thời gian này — hãy thử giảm mốc bắt đầu (start) nhé!');
  }

  // Lượt 2: Kết xuất từng khung hình ra file GIF với khử răng cưa màu mượt mà.
  const pass2 = await runFfmpegProcess(
   ffmpegPath,
   [
    '-nostdin',
    '-hide_banner',
    '-loglevel', 'error',
    '-threads', '1',
    '-protocol_whitelist', 'file,pipe',
    ...seekArgs,
    '-i', inputPath,
    '-i', palettePath,
    '-lavfi', `${baseChain} [x]; [x][1:v] paletteuse=dither=${preset.dither}:diff_mode=rectangle`,
    '-loop', '0',
    '-y', outputPath,
   ],
   FFMPEG_RENDER_TIMEOUT_MS,
  );
  const outStat = await fsp.stat(outputPath).catch(() => null);
  if (pass2.code !== 0 || !outStat || outStat.size === 0) {
   throw new Error('Không thể xuất ảnh GIF từ video này — định dạng video có thể bị lỗi.');
  }

  return {
   outputPath,
   bytes: outStat.size,
   width,
   height: height + padTop,
   fps: preset.fps,
  };
 }

 function acquireWorkerSlot() {
  if (activeWorkers < 1) {
   activeWorkers++;
   return Promise.resolve();
  }
  if (waitQueue.length >= MAX_QUEUED_JOBS) {
   return Promise.reject(new Error('Hàng đợi tạo GIF hiện đang đầy (tối đa 5 yêu cầu cùng lúc để bảo vệ RAM) — bạn chờ vài giây rồi thử lại nhé!'));
  }
  return new Promise(resolve => {
   waitQueue.push(resolve);
  });
 }

 function releaseWorkerSlot() {
  const next = waitQueue.shift();
  if (next) {
   next();
  } else {
   activeWorkers = Math.max(0, activeWorkers - 1);
  }
 }

 async function convertVideoToGif({
  sourceUrl,
  requesterId,
  options = {},
  existingToken = null,
  skipCooldown = false,
  onQueued = null,
 }) {
  const now = Date.now();
  if (!skipCooldown && requesterId) {
   const prevAt = userCooldowns.get(requesterId) ?? 0;
   if (now - prevAt < USER_COOLDOWN_MS) {
    throw new Error('Chờ 3 giây giữa hai lần tạo ảnh GIF nhé!');
   }
   if (userCooldowns.size >= 150) userCooldowns.clear();
   userCooldowns.set(requesterId, now);
  }

  const opts = normalizeGifOptions(options);
  if (activeWorkers >= 1 && typeof onQueued === 'function') {
   await onQueued(waitQueue.length + 1).catch(() => {});
  }

  await acquireWorkerSlot();
  const workDir = await fsp.mkdtemp(path.join(os.tmpdir(), TEMP_PREFIX));
  try {
   const inputPath = path.join(workDir, 'input.bin');
   await downloadToTempFile(sourceUrl, inputPath, MAX_VIDEO_DOWNLOAD_BYTES);

   const probeRes = await runFfmpegProcess(
    ffmpegPath,
    ['-nostdin', '-hide_banner', '-protocol_whitelist', 'file,pipe', '-i', inputPath],
    FFMPEG_PROBE_TIMEOUT_MS,
   );
   const probe = parseFfmpegProbeOutput(probeRes.stderr);
   if (!probe.hasVideo) {
    throw new Error('Tệp tải lên không chứa luồng hình ảnh/video hợp lệ để đổi sang GIF.');
   }
   if (probe.durationSec !== null && opts.startSec >= Math.max(0.1, probe.durationSec - 0.1)) {
    throw new Error(`Thời gian bắt đầu cắt (${opts.startSec}s) vượt quá tổng độ dài của video (${probe.durationSec.toFixed(1)}s)!`);
   }

   const effectiveInputSpan = probe.durationSec !== null
    ? Math.max(0.2, Math.min(opts.durationSec, probe.durationSec - opts.startSec))
    : opts.durationSec;

   const effectiveOpts = { ...opts, durationSec: effectiveInputSpan };
   const fontsDir = effectiveOpts.caption ? await ensureSafeFontDir() : SAFE_FONT_DIR;
   const tierOrder = effectiveOpts.quality === 'hd'
    ? ['hd', 'balanced', 'compact', 'ultra_compact']
    : (effectiveOpts.quality === 'compact' ? ['compact', 'ultra_compact'] : ['balanced', 'compact', 'ultra_compact']);

   let rendered = null;
   let usedTierIdx = 0;
   for (let idx = 0; idx < tierOrder.length; idx++) {
    const preset = GIF_QUALITY_PRESETS[tierOrder[idx]];
    rendered = await renderSingleTier({
     inputPath,
     workDir,
     probe,
     opts: effectiveOpts,
     preset,
     fontsDir,
     tierIndex: idx,
    });
    usedTierIdx = idx;
    if (rendered.bytes <= MAX_DISCORD_GIF_BYTES) break;
   }

   if (!rendered || rendered.bytes > MAX_DISCORD_GIF_BYTES) {
    throw new Error('Ảnh GIF tạo ra vẫn vượt giới hạn 8MB của Discord — hãy giảm độ dài (duration) xuống khoảng 4–6 giây nhé!');
   }

   const gifBuffer = await fsp.readFile(rendered.outputPath);
   const session = saveTuneSession({
    token: existingToken,
    sourceUrl: normalizeCandidateVideoUrl(sourceUrl),
    requesterId: String(requesterId ?? ''),
    startSec: opts.startSec,
    durationSec: opts.durationSec,
    speed: opts.speed,
    caption: opts.caption,
    captionStyle: opts.captionStyle,
    quality: opts.quality,
   });

   const outputDurationSec = Number(Math.max(0.2, effectiveInputSpan / opts.speed).toFixed(1));
   const meta = {
    bytes: gifBuffer.length,
    width: rendered.width,
    height: rendered.height,
    fps: rendered.fps,
    startSec: opts.startSec,
    durationSec: opts.durationSec,
    outputDurationSec,
    speed: opts.speed,
    caption: opts.caption,
    captionStyle: opts.captionStyle,
    quality: opts.quality,
    autoSteppedDown: usedTierIdx > 0,
   };

   return {
    gifBuffer,
    filename: 'bat-don.gif',
    attachment: new AttachmentBuilder(gifBuffer, { name: 'bat-don.gif' }),
    session,
    meta,
   };
  } finally {
   await fsp.rm(workDir, { recursive: true, force: true }).catch(() => {});
   releaseWorkerSlot();
  }
 }

 return {
  convertVideoToGif,
  downloadSmallGifBuffer,
  getTuneSession,
  saveTuneSession,
  getQueueDepth: () => waitQueue.length + activeWorkers,
 };
}
