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

export const MAX_VIDEO_DOWNLOAD_BYTES = 45 * 1024 * 1024; // 45 MiB đầu vào an toàn cho container 512MB RAM
export const MAX_DISCORD_GIF_BYTES = Math.floor(9.75 * 1024 * 1024); // 9.75 MiB (dưới trần 10 MiB mặc định của Discord & DM)
export const BOOSTED_DISCORD_GIF_BYTES = 35 * 1024 * 1024; // 35 MiB cho máy chủ có Boost Cấp 2/3 (trần Discord 50–100 MiB)
export const MIN_DURATION_SEC = 0.5;
export const MAX_DURATION_SEC = 15;
export const DEFAULT_DURATION_SEC = 6;
export const AUTO_FULL_CLIP_MAX_SEC = 8; // Nếu video gốc <= 8s và người dùng không nhập duration -> tự lấy trọn vẹn cả video!
export const MIN_SPEED = 0.25;
export const MAX_SPEED = 3.0;
export const MAX_OUTPUT_SPAN_SEC = 16;

const DOWNLOAD_TIMEOUT_MS = 25_000;
const FFMPEG_PROBE_TIMEOUT_MS = 8_000;
const FFMPEG_RENDER_TIMEOUT_MS = 75_000;
const CONVERTIO_POLL_TIMEOUT_MS = 30_000;
const USER_COOLDOWN_MS = 3_500;
const MAX_QUEUED_JOBS = 5;
const MAX_TUNE_SESSIONS = 30;
const TUNE_SESSION_TTL_MS = 20 * 60 * 1000;
const TEMP_PREFIX = 'batdon-gif-';
const SAFE_FONT_DIR = path.join(os.tmpdir(), 'batdon-gif-fonts');
// Lưu file nháp trên ổ cứng SSD (.data/gif-tmp) thay vì /tmp (tmpfs ăn thẳng vào 512MB RAM trên Pterodactyl / botkeep.cloud)!
const DISK_TEMP_ROOT = path.join(process.cwd(), '.data', 'gif-tmp');

const BUNDLED_FONT_SRC = fileURLToPath(new URL('./assets/fonts/MemeSans-Bold.ttf', import.meta.url));

// Hệ số ước lượng dung lượng tối thiểu cực bảo thủ (byte / điểm-ảnh-khung-hình) để bỏ qua các bậc chắc chắn vượt trần Discord,
// giúp xuất trúng ngay ở lượt đầu tiên giống kiến trúc Cloud Transcoder (Convertio) mà không tốn CPU chạy nháp nhiều vòng.
const CONSERVATIVE_MIN_BYTES_PER_PIXEL_FRAME = 0.032;

// Các bậc độ phân giải video thực tế (cạnh dài × cạnh ngắn chuẩn 16:9 / 9:16: Auto Gốc tối đa 1920×1080, 1600×900, 1280×720 HD, 960×540 qHD...)
export const GIF_QUALITY_PRESETS = Object.freeze({
 auto: {
  key: 'auto',
  label: 'Tự Động Tối Đa Gốc (Max Độ Nét & Max FPS của Video)',
  maxLongSide: 1920,
  maxShortSide: 1080,
  fpsExpr: null,
  fps: null,
  maxColors: 256,
  dither: 'bayer:bayer_scale=3',
  isAutoNative: true,
 },
 fhd: {
  key: 'fhd',
  label: 'Full HD 1080p Gốc (1920×1080)',
  maxLongSide: 1920,
  maxShortSide: 1080,
  fpsExpr: '100/3',
  fps: 33,
  maxColors: 256,
  dither: 'bayer:bayer_scale=3',
 },
 hd900: {
  key: 'hd900',
  label: 'HD+ 900p (1600×900)',
  maxLongSide: 1600,
  maxShortSide: 900,
  fpsExpr: '30',
  fps: 30,
  maxColors: 256,
  dither: 'bayer:bayer_scale=3',
 },
 ultra: {
  key: 'ultra',
  label: 'Chuẩn 720p HD (1280×720)',
  maxLongSide: 1280,
  maxShortSide: 720,
  fpsExpr: '100/3',
  fps: 33,
  maxColors: 256,
  dither: 'bayer:bayer_scale=3',
 },
 hd: {
  key: 'hd',
  label: 'Nét Cao 540p qHD (960×540)',
  maxLongSide: 960,
  maxShortSide: 540,
  fpsExpr: '25',
  fps: 25,
  maxColors: 256,
  dither: 'bayer:bayer_scale=3',
 },
 balanced: {
  key: 'balanced',
  label: 'Cân Bằng 432p (768×432)',
  maxLongSide: 768,
  maxShortSide: 432,
  fpsExpr: '20',
  fps: 20,
  maxColors: 256,
  dither: 'bayer:bayer_scale=3',
 },
 compact: {
  key: 'compact',
  label: 'Nén Gọn 360p (640×360)',
  maxLongSide: 640,
  maxShortSide: 360,
  fpsExpr: '50/3',
  fps: 17,
  maxColors: 224,
  dither: 'bayer:bayer_scale=2',
 },
 ultra_compact: {
  key: 'ultra_compact',
  label: 'Siêu Nén 270p (480×270)',
  maxLongSide: 480,
  maxShortSide: 270,
  fpsExpr: '25/2',
  fps: 12,
  maxColors: 160,
  dither: 'bayer:bayer_scale=2',
 },
});

// Tự động tính FPS tối đa chuẩn 1:1 theo FPS thực của video đầu vào (trần định dạng GIF89a là 50 FPS = 20ms/frame;
// >50 FPS trình duyệt web & Discord sẽ kẹp chậm về 10 FPS). Video 24/25/30/50 FPS được giữ nguyên nhịp khung hình gốc 1:1!
export function resolveSourceMaxFps(sourceFps, speed = 1) {
 const spd = Number(speed) > 0 ? Number(speed) : 1;
 if (!Number.isFinite(sourceFps) || sourceFps <= 0) {
  return { fpsExpr: '100/3', fpsLabel: 33 };
 }
 const effective = sourceFps * spd;
 if (effective >= 46) {
  return { fpsExpr: '50', fpsLabel: 50 };
 }
 const rounded = Math.max(8, Math.min(50, Math.round(effective)));
 if (rounded === 33 || rounded === 34) {
  return { fpsExpr: '100/3', fpsLabel: 33 };
 }
 return { fpsExpr: String(rounded), fpsLabel: rounded };
}

// Chuẩn hóa FPS do người dùng chỉ định thủ công về đúng mốc centi-giây chuẩn của định dạng GIF89a (8–50 FPS).
export function resolveExactGifFps(rawFps, fallbackPreset = GIF_QUALITY_PRESETS.auto) {
 if (rawFps === undefined || rawFps === null || rawFps === '') {
  return {
   fpsExpr: fallbackPreset?.fpsExpr ?? null,
   fpsLabel: fallbackPreset?.fps ?? null,
   customFps: null,
  };
 }
 const n = Number(String(rawFps).trim().replace(/fps$/i, '').trim());
 if (!Number.isFinite(n) || n < 8 || n > 60) {
  throw new Error('Số khung hình FPS phải nằm trong khoảng từ 8 đến 50 FPS (VD: 20, 25, 33, 50).');
 }
 if (n >= 42) return { fpsExpr: '50', fpsLabel: 50, customFps: 50 };
 if (n >= 29) return { fpsExpr: '100/3', fpsLabel: 33, customFps: 33 };
 if (n >= 23) return { fpsExpr: '25', fpsLabel: 25, customFps: 25 };
 if (n >= 18) return { fpsExpr: '20', fpsLabel: 20, customFps: 20 };
 if (n >= 15) return { fpsExpr: '50/3', fpsLabel: 17, customFps: 17 };
 return { fpsExpr: '25/2', fpsLabel: 12, customFps: 12 };
}

export function parseQualityAndFpsInput(raw, fallbackQuality = 'auto', fallbackFps = null) {
 const txt = String(raw ?? '').trim().toLowerCase();
 if (!txt) return { quality: fallbackQuality, fps: fallbackFps };

 let quality = fallbackQuality;
 let resetAutoFps = false;
 if (/\b(auto|tudong|automax|maxgoc)\b/.test(txt)) {
  quality = 'auto';
  resetAutoFps = true;
 } else if (/\b(fhd|fullhd|1080p?|goc|native)\b/.test(txt)) {
  quality = 'fhd';
 } else if (/\b(hd900|900p?)\b/.test(txt)) {
  quality = 'hd900';
 } else if (/\b(ultra|720p?|max|sieucap)\b/.test(txt)) {
  quality = 'ultra';
 } else if (/\b(hd|540p?|600p?|cao)\b/.test(txt)) {
  quality = 'hd';
 } else if (/\b(balanced|432p?|480p?|vua)\b/.test(txt)) {
  quality = 'balanced';
 } else if (/\b(compact|360p?|nhe|nho)\b/.test(txt)) {
  quality = 'compact';
 }

 const cleanedForFps = txt.replace(/\b(1080p|900p|720p|600p|540p|480p|432p|360p|280p|270p)\b/g, ' ');
 const fpsMatch = cleanedForFps.match(/\b(\d{1,2})(?:\s*fps)?\b/);
 const fps = fpsMatch
  ? resolveExactGifFps(Number(fpsMatch[1])).customFps
  : (resetAutoFps ? null : fallbackFps);
 return { quality, fps };
}

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

 const hasExplicitDuration = raw.duration !== undefined && raw.duration !== null && raw.duration !== '';
 let durationSec = hasExplicitDuration ? Number(raw.duration) : DEFAULT_DURATION_SEC;
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

 // Chặn trường hợp quay chậm 0.25x trên đoạn 15s tạo ra GIF dài 60s làm tràn trần tải lên.
 let cappedBySlowMo = false;
 if (durationSec / speed > MAX_OUTPUT_SPAN_SEC) {
  durationSec = Math.max(MIN_DURATION_SEC, Math.round(MAX_OUTPUT_SPAN_SEC * speed * 100) / 100);
  cappedBySlowMo = true;
 }

 // Mặc định là 'auto' -> tự nhận diện độ phân giải gốc tối đa & FPS tối đa của video đầu vào!
 const qualityKey = GIF_QUALITY_PRESETS[raw.quality] ? raw.quality : 'auto';
 const presetObj = GIF_QUALITY_PRESETS[qualityKey];
 const { fpsExpr, fpsLabel, customFps } = resolveExactGifFps(raw.fps, presetObj);
 const captionStyle = GIF_CAPTION_STYLES[raw.captionStyle] ? raw.captionStyle : 'bar';
 const caption = String(raw.caption ?? '')
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
  .trim()
  .slice(0, 140);

 return {
  startSec,
  durationSec,
  hasExplicitDuration,
  speed,
  quality: qualityKey,
  fps: customFps,
  fpsExpr,
  fpsLabel,
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

// Tính toán kích thước đầu ra chẵn theo chuẩn độ phân giải thực (KHÔNG BAO GIỜ phóng to vượt độ phân giải gốc của video!).
export function computeScaledDimensions(inWidth, inHeight, preset) {
 const w = Math.max(2, Number(inWidth) || 960);
 const h = Math.max(2, Number(inHeight) || 540);
 const longCap = preset?.maxLongSide ?? preset?.maxWidth ?? 1920;
 const shortCap = preset?.maxShortSide ?? preset?.maxHeight ?? 1080;
 const maxW = w >= h ? longCap : shortCap;
 const maxH = w >= h ? shortCap : longCap;
 const ratio = Math.min(1, maxW / w, maxH / h);
 const minFloor = Math.min(64, Math.max(2, Math.floor(Math.min(w, h) / 2) * 2));
 const outW = Math.max(minFloor, Math.round((w * ratio) / 2) * 2);
 const outH = Math.max(minFloor, Math.round((h * ratio) / 2) * 2);
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

 const maxChars = width < height ? 23 : 27;
 const topLines = topRaw ? wrapCaptionLines(topRaw, maxChars, 3) : [];
 const bottomLines = bottomRaw ? wrapCaptionLines(bottomRaw, maxChars, 3) : [];
 if (topLines.length === 0 && bottomLines.length === 0) {
  return { padTop: 0, assContent: null };
 }

 const useWhiteBar = topLines.length > 0 && captionStyle === 'bar';
 const barFontSize = Math.max(16, Math.min(114, Math.round(width * 0.055)));
 const subFontSize = Math.max(17, Math.min(120, Math.round(width * 0.058)));
 const lineStep = Math.round(barFontSize * 1.28);
 const padTop = useWhiteBar
  ? Math.round((topLines.length * lineStep + Math.max(18, Math.round(barFontSize * 0.85))) / 2) * 2
  : 0;
 const totalHeight = height + padTop;
 const barMarginV = useWhiteBar
  ? Math.max(8, Math.round((padTop - topLines.length * lineStep) / 2) + 2)
  : Math.max(14, Math.round(height * 0.032));
 const subMarginV = Math.max(14, Math.round(height * 0.032));
 const horizMargin = Math.max(12, Math.round(width * 0.03));
 const outlinePx = Math.max(2, Math.round(subFontSize * 0.11));

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
  `Style: MemeBar,DejaVu Sans,${barFontSize},&H00111111,&H00111111,&H00FFFFFF,&H00FFFFFF,-1,0,0,0,100,100,0,0,1,0,0,8,${horizMargin},${horizMargin},${barMarginV},1`,
  `Style: MemeTop,DejaVu Sans,${subFontSize},&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,${outlinePx},1,8,${horizMargin},${horizMargin},${subMarginV},1`,
  `Style: MemeSub,DejaVu Sans,${subFontSize},&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,${outlinePx},1,2,${horizMargin},${horizMargin},${subMarginV},1`,
  '',
  '[Events]',
  'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ...dialogues,
  '',
 ].join('\n');

 return { padTop, assContent };
}

// Tự động nhận diện thông số gốc của Video từ `ffmpeg -i`:
// - Tự chọn đúng luồng Video chuyển động thực, bỏ qua ảnh bìa đính kèm `(attached pic)` thường gặp trên video TikTok/CapCut/YouTube!
// - Đọc chính xác độ phân giải gốc (width × height + tự đảo chiều khi có cờ xoay 90/270 độ của điện thoại), FPS gốc và thời lượng gốc.
export function parseFfmpegProbeOutput(stderrText) {
 const text = String(stderrText ?? '');
 const streamHeaderRe = /Stream #(\d+):(\d+)[^\n]*?:\s*Video:\s*([^\n]+)/gi;
 const candidates = [];
 let match;
 while ((match = streamHeaderRe.exec(text)) !== null) {
  const startPos = match.index;
  const tail = text.slice(startPos + match[0].length);
  const nextStreamIdx = tail.search(/\n\s*Stream #\d+:\d+/i);
  const metaBlock = nextStreamIdx >= 0 ? tail.slice(0, nextStreamIdx) : tail;
  const videoLine = match[3];
  const isAttachedPic = /\(attached pic\)/i.test(videoLine);
  candidates.push({
   inputIdx: Number(match[1]),
   streamIdx: Number(match[2]),
   videoLine,
   metaBlock,
   isAttachedPic,
  });
 }

 if (candidates.length === 0) {
  return {
   hasVideo: false,
   width: 0,
   height: 0,
   fps: null,
   durationSec: null,
   codec: null,
   streamSpec: '0:V:0',
   isAnimatedWebp: false,
  };
 }

 const chosen = candidates.find(c => !c.isAttachedPic) ?? candidates[0];
 const { videoLine, metaBlock } = chosen;
 const streamSpec = `${chosen.inputIdx}:${chosen.streamIdx}`;

 const codecMatch = videoLine.match(/^([a-z0-9_]+)/i);
 const codec = codecMatch ? codecMatch[1].toLowerCase() : null;
 const isAnimatedWebp = codec === 'webp' && /skipping unsupported chunk:\s*ANIM/i.test(text);

 const dimMatch = videoLine.match(/(?:^|[,\s])(\d{2,5})x(\d{2,5})(?=[\s,\[])/);
 let width = dimMatch ? Number(dimMatch[1]) : 640;
 let height = dimMatch ? Number(dimMatch[2]) : 360;

 // Video quay dọc bằng điện thoại iPhone/Android thường lưu ngang kèm cờ xoay +-90 / 270 độ.
 const rotContext = candidates.length === 1 ? text : `${videoLine}\n${metaBlock}`;
 if (
  /rotation of -?(?:90|270)(?:\.0+)? degrees/i.test(rotContext)
  || /\brotate\s*:\s*-?(?:90|270)\b/i.test(rotContext)
 ) {
  [width, height] = [height, width];
 }

 // Đọc tốc độ khung hình gốc (FPS thực) của video.
 let fps = null;
 const fpsMatch = videoLine.match(/(\d+(?:\.\d+)?)\s*fps\b/i);
 if (fpsMatch) {
  const val = Number(fpsMatch[1]);
  if (Number.isFinite(val) && val >= 1 && val <= 240) {
   fps = Math.round(val * 100) / 100;
  }
 }
 if (fps === null) {
  const tbrMatch = videoLine.match(/(\d+(?:\.\d+)?)\s*tbr\b/i);
  if (tbrMatch) {
   const val = Number(tbrMatch[1]);
   if (Number.isFinite(val) && val >= 5 && val <= 120) {
    fps = Math.round(val * 100) / 100;
   }
  }
 }

 let durationSec = null;
 const durMatch = text.match(/Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/i)
  ?? text.match(/\bDURATION\s*:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/i);
 if (durMatch) {
  const parsed = Number(durMatch[1]) * 3600 + Number(durMatch[2]) * 60 + Number(durMatch[3]);
  if (Number.isFinite(parsed) && parsed > 0) durationSec = parsed;
 }

 return {
  hasVideo: true,
  width,
  height,
  fps,
  durationSec,
  codec,
  streamSpec,
  isAnimatedWebp,
 };
}

// Xây dựng danh sách phương án kết xuất thông minh:
// - Ở chế độ mặc định 'auto': Tự khóa vào ĐỘ PHÂN GIẢI TỐI ĐA GỐC (tới 1920×1080) & FPS TỐI ĐA GỐC của video (tới 50 FPS),
//   không bao giờ phóng đại vượt kích thước gốc hay nhân bản khung hình giả vượt FPS gốc, đồng thời tự ước lượng ngân sách
//   điểm ảnh để bỏ qua các bậc chắc chắn lố trần Discord (tránh render nháp nhiều lần tốn CPU).
export function buildRenderCandidates({ probe, opts, uploadCap = MAX_DISCORD_GIF_BYTES }) {
 const nativeMax = resolveSourceMaxFps(probe.fps, opts.speed);
 const ladderKeys = ['fhd', 'hd900', 'ultra', 'hd', 'balanced', 'compact', 'ultra_compact'];
 const startKey = opts.quality === 'auto' ? 'fhd' : (GIF_QUALITY_PRESETS[opts.quality] ? opts.quality : 'fhd');
 const startIdx = Math.max(0, ladderKeys.indexOf(startKey));
 const activeKeys = ladderKeys.slice(startIdx);

 const rawCandidates = [];
 for (let i = 0; i < activeKeys.length; i++) {
  const key = activeKeys[i];
  const preset = GIF_QUALITY_PRESETS[key];
  const { width, height } = computeScaledDimensions(probe.width, probe.height, preset);

  let fpsExpr;
  let fpsLabel;
  if (i === 0 && opts.fps !== null) {
   // Người dùng chủ động chọn FPS cụ thể ở bậc đầu tiên
   fpsExpr = opts.fpsExpr;
   fpsLabel = opts.fpsLabel;
  } else if (opts.quality === 'auto' && i <= 2) {
   // Chế độ Tự Động Tối Đa: ưu tiên giữ trọn FPS tối đa của video gốc ở các bậc phân giải cao!
   fpsExpr = nativeMax.fpsExpr;
   fpsLabel = nativeMax.fpsLabel;
  } else {
   // Ở các bậc hạ nén sâu hơn: lấy min(FPS bậc nén, FPS tối đa gốc của video) để không bao giờ tạo khung hình thừa
   if (nativeMax.fpsLabel < preset.fps) {
    fpsExpr = nativeMax.fpsExpr;
    fpsLabel = nativeMax.fpsLabel;
   } else {
    fpsExpr = preset.fpsExpr;
    fpsLabel = preset.fps;
   }
  }

  rawCandidates.push({
   qualityKey: opts.quality === 'auto' && i === 0 ? 'auto' : key,
   presetKey: key,
   width,
   height,
   fpsExpr,
   fpsLabel,
   maxColors: preset.maxColors,
   dither: preset.dither,
  });
 }

 // Loại bỏ các phương án trùng khít kích thước + FPS (VD: video gốc 640×360 thì bậc 1080p/720p/540p đều ra 640×360 -> chỉ xuất 1 lần!)
 const deduped = [];
 const seen = new Set();
 for (const cand of rawCandidates) {
  const sig = `${cand.width}x${cand.height}@${cand.fpsLabel}:${cand.maxColors}`;
  if (!seen.has(sig)) {
   seen.add(sig);
   deduped.push(cand);
  }
 }

 // Bộ lọc ngân sách điểm ảnh thông minh (chỉ bỏ qua các bậc chắc chắn vượt xa trần uploadCap để tiết kiệm CPU cho Bot):
 const outputSpanSec = Math.max(0.2, opts.durationSec / opts.speed);
 const filtered = deduped.filter((cand, idx) => {
  if (idx === deduped.length - 1) return true; // Luôn giữ bậc cuối cùng làm chốt chặn an toàn
  // Nếu người dùng cố tình chọn tay bậc chất lượng cụ thể (VD: /gif quality:fhd) thì vẫn thử bậc đầu của họ
  if (opts.quality !== 'auto' && idx === 0) return true;
  const minExpectedBytes = cand.width * cand.height * cand.fpsLabel * outputSpanSec * CONSERVATIVE_MIN_BYTES_PER_PIXEL_FRAME;
  return minExpectedBytes <= uploadCap;
 });

 return {
  candidates: filtered.length > 0 ? filtered : [deduped[deduped.length - 1]],
  skippedForBudget: deduped.length - filtered.length,
  nativeMaxFps: nativeMax.fpsLabel,
 };
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

function runFfmpegProcess(ffmpegPath, args, timeoutMs, cwd = undefined) {
 return new Promise((resolve, reject) => {
  const child = spawn(ffmpegPath, args, {
   cwd,
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
  child.on('close', (code, signal) => {
   clearTimeout(timer);
   if (killedByTimeout) {
    reject(new Error('Quá thời gian xử lý video — hãy thử cắt đoạn ngắn hơn (4–8 giây) nhé!'));
    return;
   }
   resolve({ code: code ?? 1, signal: signal ?? null, stderr });
  });
 });
}

export function buildGifTuneModal(token, session = {}) {
 const timingDefault = `${session.startSec ?? 0} - ${session.durationSec ?? DEFAULT_DURATION_SEC}`;
 const qKey = session.quality ?? 'auto';
 const qFpsDefault = qKey === 'auto'
  ? 'auto'
  : `${qKey} ${session.fps ?? GIF_QUALITY_PRESETS[qKey]?.fps ?? 30}`;
 return new ModalBuilder()
  .setCustomId(`gif_tune_modal:${token}`)
  .setTitle('🎞️ Chỉnh ảnh GIF, Độ nét & FPS')
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
   new ActionRowBuilder().addComponents(
    new TextInputBuilder()
     .setCustomId('gif_quality_fps')
     .setLabel('Độ nét & FPS (auto / 1080p / 720p + FPS)')
     .setStyle(TextInputStyle.Short)
     .setRequired(false)
     .setMaxLength(24)
     .setValue(qFpsDefault)
     .setPlaceholder('auto = Tự lấy Max Độ Nét & Max FPS gốc; hoặc fhd 50, ultra 33'),
   ),
  );
}

export function buildGifActionComponents({ token, requesterId, includeDmSave = true, includeDelete = true } = {}) {
 const buttons = [];
 if (token) {
  buttons.push(
   new ButtonBuilder()
    .setCustomId(`gif_tune:${token}`)
    .setLabel('Chữ Meme / Độ nét & FPS')
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
 const title = meta.isNativeMax
  ? '🎞️ **Đã tạo ảnh GIF chuẩn gốc tối đa!**'
  : '🎞️ **Đã tạo ảnh GIF nét cao!**';
 const autoCompressed = meta.autoSteppedDown ? ' *(đã tự căn nét & FPS cao nhất vừa trần Discord)*' : '';
 return `${title} *(${meta.width}×${meta.height} • ${meta.fps} FPS • ${meta.outputDurationSec}s${speedTag}${cutTag}${capTag} • ${sizeMb} MB)*${autoCompressed}`;
}

export function createVideoToGifManager({
 ffmpegPath,
 lookupFn = dns.lookup,
 fetchFn = globalThis.fetch,
 convertioApiKey = process.env.CONVERTIO_API_KEY,
 tempBaseDir = null,
} = {}) {
 if (!ffmpegPath) throw new Error('Thiếu đường dẫn ffmpeg-static cho bộ chuyển đổi GIF.');

 const userCooldowns = new Map();
 const tuneSessions = new Map();
 const waitQueue = [];
 let activeWorkers = 0;
 let fontReadyPromise = null;
 let resolvedStagingRoot = null;

 // Ưu tiên ổ cứng SSD (.data/gif-tmp) thay vì /tmp (tmpfs ăn vào RAM 512MB trên botkeep.cloud)!
 function getStagingRootSync() {
  if (resolvedStagingRoot) return resolvedStagingRoot;
  const preferred = tempBaseDir || DISK_TEMP_ROOT;
  try {
   fs.mkdirSync(preferred, { recursive: true });
   resolvedStagingRoot = preferred;
   return resolvedStagingRoot;
  } catch {
   resolvedStagingRoot = os.tmpdir();
   return resolvedStagingRoot;
  }
 }

 function sweepStaleTempDirsSync() {
  const roots = new Set([os.tmpdir(), getStagingRootSync()]);
  for (const rootDir of roots) {
   try {
    for (const entry of fs.readdirSync(rootDir)) {
     if (entry.startsWith(TEMP_PREFIX)) {
      fs.rmSync(path.join(rootDir, entry), { recursive: true, force: true });
     }
    }
   } catch {}
  }
 }
 sweepStaleTempDirsSync();

 async function createStagingWorkDir() {
  const root = getStagingRootSync();
  await fsp.mkdir(root, { recursive: true }).catch(() => {});
  return fsp.mkdtemp(path.join(root, TEMP_PREFIX));
 }

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
     'User-Agent': 'Mozilla/5.0 (compatible; BatDonDiscordBot/2.1)',
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
    throw new Error('Video quá lớn (vượt mức an toàn 45MB) — hãy cắt ngắn hoặc gửi clip nhẹ hơn nhé!');
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
     cb(new Error('Video quá lớn (vượt mức an toàn 45MB) — hãy cắt ngắn hoặc gửi clip nhẹ hơn nhé!'));
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

 async function downloadSmallGifBuffer(rawUrl, maxBytes = 25 * 1024 * 1024) {
  const tmpDir = await createStagingWorkDir();
  const tmpPath = path.join(tmpDir, 'copy.gif');
  try {
   await downloadToTempFile(rawUrl, tmpPath, maxBytes);
   return await fsp.readFile(tmpPath);
  } finally {
   await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
 }

 // Tùy chọn đẩy tải lên đám mây Convertio API (0% CPU/RAM trên Bot) nếu chủ bot khai báo CONVERTIO_API_KEY;
 // tự động fallback êm ái về Engine Local Turbo nếu không có key hoặc API đám mây hết hạn mức / vượt trần dung lượng!
 async function tryConvertViaConvertioCloud({ safeSourceUrl, workDir, uploadCap }) {
  const key = String(convertioApiKey ?? '').trim();
  if (!key) return null;
  let convId = null;
  try {
   const startRes = await fetchFn('https://api.convertio.co/convert', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
     apikey: key,
     input: 'url',
     file: safeSourceUrl,
     outputformat: 'gif',
    }),
    signal: AbortSignal.timeout(10_000),
   });
   const startJson = await startRes.json().catch(() => null);
   convId = startJson?.data?.id;
   if (!startRes.ok || !convId) return null;

   const deadline = Date.now() + CONVERTIO_POLL_TIMEOUT_MS;
   while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 1400));
    const pollRes = await fetchFn(`https://api.convertio.co/convert/${encodeURIComponent(convId)}/status`, {
     method: 'GET',
     signal: AbortSignal.timeout(8_000),
    });
    const pollJson = await pollRes.json().catch(() => null);
    const step = pollJson?.data?.step;
    if (step === 'finish' && pollJson?.data?.output?.url) {
     const cloudPath = path.join(workDir, 'cloud-out.gif');
     await downloadToTempFile(pollJson.data.output.url, cloudPath, uploadCap);
     const probeCloud = await runFfmpegProcess(
      ffmpegPath,
      ['-nostdin', '-hide_banner', '-protocol_whitelist', 'file,pipe', '-i', cloudPath],
      FFMPEG_PROBE_TIMEOUT_MS,
     );
     const parsed = parseFfmpegProbeOutput(probeCloud.stderr);
     const st = await fsp.stat(cloudPath).catch(() => null);
     if (st && st.size > 0 && st.size <= uploadCap) {
      return {
       outputPath: cloudPath,
       bytes: st.size,
       width: parsed.width || 640,
       height: parsed.height || 360,
       fps: Math.round(parsed.fps || 25),
       durationSec: parsed.durationSec || DEFAULT_DURATION_SEC,
      };
     }
     await fsp.unlink(cloudPath).catch(() => {});
     return null;
    }
    if (pollJson?.status === 'error') return null;
   }
   return null;
  } catch {
   return null;
  } finally {
   if (convId) {
    fetchFn(`https://api.convertio.co/convert/${encodeURIComponent(convId)}`, {
     method: 'DELETE',
     signal: AbortSignal.timeout(4_000),
    }).catch(() => {});
   }
  }
 }

 // Lượt 1 Siêu Nhẹ kiểu Convertio: tạo bảng màu 256 màu 1 LẦN DUY NHẤT ở kích thước thu nhỏ 320p @ 8 FPS (< 0.1 giây, ~35MB RAM)!
 async function generateSharedPalette({ workDir, probe, opts }) {
  const seekArgs = [];
  if (opts.startSec > 0) {
   seekArgs.push('-ss', String(opts.startSec));
  }
  seekArgs.push('-t', String(opts.durationSec));

  const sampleFps = opts.durationSec / opts.speed < 1.0 ? 15 : 8;
  const speedChain = opts.speed === 1 ? 'setpts=PTS-STARTPTS' : `setpts=(PTS-STARTPTS)/${opts.speed}`;
  // Nếu có chèn chữ Meme (thanh trắng + chữ đen / viền đen), chèn dải mẫu trắng & đen siêu nhỏ để bảng màu chắc chắn có đủ #FFFFFF & #000000!
  const captionColorAnchor = opts.caption
   ? ',pad=iw:ih+4:0:2:white,drawbox=x=0:y=0:w=16:h=2:color=black@1:t=fill'
   : '';
  const vf = `${speedChain},fps=${sampleFps},scale='min(320,iw)':-2:flags=fast_bilinear${captionColorAnchor},palettegen=max_colors=256:stats_mode=full`;

  const pass1 = await runFfmpegProcess(
   ffmpegPath,
   [
    '-nostdin',
    '-hide_banner',
    '-loglevel', 'error',
    '-threads', '1',
    '-fflags', '+genpts+discardcorrupt',
    '-err_detect', 'ignore_err',
    '-max_error_rate', '1.0',
    '-protocol_whitelist', 'file,pipe',
    ...seekArgs,
    '-i', 'input.bin',
    '-map', probe.streamSpec,
    '-an', '-sn', '-dn',
    '-vf', vf,
    '-frames:v', '1',
    '-update', '1',
    '-y', 'palette.png',
   ],
   FFMPEG_RENDER_TIMEOUT_MS,
   workDir,
  );
  const palStat = await fsp.stat(path.join(workDir, 'palette.png')).catch(() => null);
  if (pass1.code !== 0 || !palStat || palStat.size === 0) {
   throw new Error('Không thể trích xuất khung hình tại mốc thời gian này — hãy thử giảm mốc bắt đầu (start) nhé!');
  }
  return path.join(workDir, 'palette.png');
 }

 // Lượt 2 Tối Ưu Tốc Độ & RAM:
 // - Bỏ qua hoàn toàn bộ lọc scale khi xuất đúng độ phân giải 1:1 gốc của video (Zero-Scale Bypass -> giảm 40–60% CPU!).
 // - Chỉ định rõ luồng video thật `[0:<idx>]` và tắt giải mã âm thanh `-an -sn -dn` để không bao giờ kẹt vì ảnh bìa đính kèm.
 async function renderCandidatePass2({
  workDir,
  probe,
  opts,
  candidate,
  fontsDir,
  tierIndex,
 }) {
  const { width, height } = candidate;
  const { padTop, assContent } = buildMemeAssConfig({
   width,
   height,
   caption: opts.caption,
   captionStyle: opts.captionStyle,
  });

  const filterSteps = [
   opts.speed === 1 ? 'setpts=PTS-STARTPTS' : `setpts=(PTS-STARTPTS)/${opts.speed}`,
   `fps=${candidate.fpsExpr}`,
  ];
  // Chỉ chạy bộ co giãn ảnh khi kích thước đích khác kích thước gốc của video!
  if (width !== probe.width || height !== probe.height) {
   filterSteps.push(`scale=${width}:${height}:flags=bicubic`);
  }
  if (padTop > 0) {
   filterSteps.push(`pad=${width}:${height + padTop}:0:${padTop}:white`);
  }
  if (assContent) {
   const assFileName = `cap-${tierIndex}.ass`;
   await fsp.writeFile(path.join(workDir, assFileName), assContent, 'utf8');
   filterSteps.push(`ass=filename=${assFileName}:fontsdir=${fontsDir}`);
  }
  const videoChain = filterSteps.join(',');

  const seekArgs = [];
  if (opts.startSec > 0) {
   seekArgs.push('-ss', String(opts.startSec));
  }
  seekArgs.push('-t', String(opts.durationSec));

  // Nếu bậc nén thấp cần <= 224 màu thì tạo bảng màu tinh gọn riêng cho bậc đó (<0.06s), còn lại dùng chung palette.png 256 màu!
  let paletteName = 'palette.png';
  if (candidate.maxColors < 256) {
   paletteName = `pal-${tierIndex}.png`;
   await runFfmpegProcess(
    ffmpegPath,
    [
     '-nostdin', '-hide_banner', '-loglevel', 'error', '-threads', '1',
     '-i', 'palette.png',
     '-vf', `palettegen=max_colors=${candidate.maxColors}:stats_mode=single`,
     '-frames:v', '1', '-update', '1',
     '-y', paletteName,
    ],
    10_000,
    workDir,
   );
   const subPalStat = await fsp.stat(path.join(workDir, paletteName)).catch(() => null);
   if (!subPalStat || subPalStat.size === 0) paletteName = 'palette.png';
  }

  const outFileName = `out-${tierIndex}.gif`;
  const outputPath = path.join(workDir, outFileName);
  const pass2 = await runFfmpegProcess(
   ffmpegPath,
   [
    '-nostdin',
    '-hide_banner',
    '-loglevel', 'error',
    '-threads', '1',
    '-fflags', '+genpts+discardcorrupt',
    '-err_detect', 'ignore_err',
    '-max_error_rate', '1.0',
    '-protocol_whitelist', 'file,pipe',
    ...seekArgs,
    '-i', 'input.bin',
    '-i', paletteName,
    '-an', '-sn', '-dn',
    '-filter_complex', `[${probe.streamSpec}]${videoChain}[x];[x][1:v:0]paletteuse=dither=${candidate.dither}:diff_mode=rectangle`,
    '-loop', '0',
    '-y', outFileName,
   ],
   FFMPEG_RENDER_TIMEOUT_MS,
   workDir,
  );

  const outStat = await fsp.stat(outputPath).catch(() => null);
  if (pass2.code !== 0 || !outStat || outStat.size === 0) {
   await fsp.unlink(outputPath).catch(() => {});
   const errMsg = pass2.signal === 'SIGKILL'
    ? 'Bậc độ phân giải này vượt ngưỡng RAM tạm thời của máy chủ.'
    : /No space left on device/i.test(pass2.stderr)
     ? 'Ổ đĩa tạm trên máy chủ đã đầy khi xuất ảnh GIF.'
     : 'Không thể xuất ảnh GIF ở bậc độ phân giải này.';
   const err = new Error(errMsg);
   err.ffmpegDetail = pass2.stderr?.slice(-300) || pass2.signal || String(pass2.code);
   throw err;
  }

  return {
   outputPath,
   bytes: outStat.size,
   width,
   height: height + padTop,
   padTop,
   fps: candidate.fpsLabel,
   qualityKey: candidate.qualityKey,
   presetKey: candidate.presetKey,
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
  maxUploadBytes = MAX_DISCORD_GIF_BYTES,
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
  const uploadCap = Math.max(2 * 1024 * 1024, Number(maxUploadBytes) || MAX_DISCORD_GIF_BYTES);
  if (activeWorkers >= 1 && typeof onQueued === 'function') {
   await onQueued(waitQueue.length + 1).catch(() => {});
  }

  await acquireWorkerSlot();
  const workDir = await createStagingWorkDir();
  try {
   // Nếu có cấu hình CONVERTIO_API_KEY và là yêu cầu đổi thuần tự động -> ưu tiên đẩy lên đám mây Convertio (0% CPU/RAM Bot)!
   const canOffloadCloud = Boolean(String(convertioApiKey ?? '').trim())
    && !opts.caption
    && opts.startSec === 0
    && !opts.hasExplicitDuration
    && opts.speed === 1
    && opts.quality === 'auto'
    && opts.fps === null;

   if (canOffloadCloud) {
    const safeUrl = await assertSafePublicUrl(sourceUrl, lookupFn);
    const cloudRendered = await tryConvertViaConvertioCloud({ safeSourceUrl: safeUrl, workDir, uploadCap });
    if (cloudRendered) {
     const gifBuffer = await fsp.readFile(cloudRendered.outputPath);
     await fsp.unlink(cloudRendered.outputPath).catch(() => {});
     const clipDur = Number(Math.min(MAX_DURATION_SEC, Math.max(0.5, cloudRendered.durationSec)).toFixed(1));
     const session = saveTuneSession({
      token: existingToken,
      sourceUrl: normalizeCandidateVideoUrl(sourceUrl),
      requesterId: String(requesterId ?? ''),
      startSec: 0,
      durationSec: clipDur,
      speed: 1,
      caption: '',
      captionStyle: opts.captionStyle,
      quality: 'auto',
      fps: cloudRendered.fps,
     });
     return {
      gifBuffer,
      filename: 'bat-don.gif',
      attachment: new AttachmentBuilder(gifBuffer, { name: 'bat-don.gif' }),
      session,
      meta: {
       bytes: gifBuffer.length,
       width: cloudRendered.width,
       height: cloudRendered.height,
       fps: cloudRendered.fps,
       startSec: 0,
       durationSec: clipDur,
       outputDurationSec: clipDur,
       speed: 1,
       caption: '',
       captionStyle: opts.captionStyle,
       quality: 'auto',
       isNativeMax: true,
       autoSteppedDown: false,
      },
     };
    }
   }

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
   if (probe.isAnimatedWebp) {
    throw new Error('Định dạng ảnh động WebP (Sticker) hiện không chứa luồng video chuẩn — hãy gửi file video (.mp4, .mov, .webm) hoặc GIF nhé!');
   }
   if (probe.durationSec !== null && opts.startSec >= Math.max(0.1, probe.durationSec - 0.1)) {
    throw new Error(`Thời gian bắt đầu cắt (${opts.startSec}s) vượt quá tổng độ dài của video (${probe.durationSec.toFixed(1)}s)!`);
   }

   // Nếu người dùng không điền duration và video gốc ngắn (<= 8s), tự lấy trọn vẹn cả video thay vì cắt cụt ở 6s!
   let requestedDuration = opts.durationSec;
   if (!opts.hasExplicitDuration && probe.durationSec !== null) {
    const remaining = Math.max(0.2, probe.durationSec - opts.startSec);
    if (remaining <= AUTO_FULL_CLIP_MAX_SEC) {
     requestedDuration = Math.min(remaining, MAX_OUTPUT_SPAN_SEC * opts.speed);
    }
   }

   const effectiveInputSpan = probe.durationSec !== null
    ? Math.max(0.2, Math.min(requestedDuration, probe.durationSec - opts.startSec))
    : requestedDuration;

   const effectiveOpts = {
    ...opts,
    durationSec: Math.round(effectiveInputSpan * 100) / 100,
   };
   const fontsDir = effectiveOpts.caption ? await ensureSafeFontDir() : SAFE_FONT_DIR;

   // Lượt 1: Tạo bảng màu chung siêu tốc 1 lần duy nhất (< 0.1s)
   await generateSharedPalette({ workDir, probe, opts: effectiveOpts });

   // Lập danh sách bậc xuất tối ưu dựa trên thông số video gốc vừa tự nhận diện
   const { candidates, skippedForBudget, nativeMaxFps } = buildRenderCandidates({
    probe,
    opts: effectiveOpts,
    uploadCap,
   });

   let rendered = null;
   let usedIdx = 0;
   let lastPass2Err = null;

   for (let idx = 0; idx < candidates.length; idx++) {
    try {
     const attempt = await renderCandidatePass2({
      workDir,
      probe,
      opts: effectiveOpts,
      candidate: candidates[idx],
      fontsDir,
      tierIndex: idx,
     });
     if (attempt.bytes <= uploadCap) {
      rendered = attempt;
      usedIdx = idx;
      break;
     }
     // Nếu vượt trần upload Discord: xóa ngay lập tức file lớn trên ổ đĩa trước khi thử bậc kế tiếp!
     if (idx < candidates.length - 1) {
      await fsp.unlink(attempt.outputPath).catch(() => {});
     } else {
      rendered = attempt;
      usedIdx = idx;
     }
    } catch (err) {
     lastPass2Err = err;
     console.warn(`[gif-engine] Bậc #${idx} (${candidates[idx].width}x${candidates[idx].height}@${candidates[idx].fpsLabel}fps) lỗi, tự hạ bậc nhẹ hơn:`, err?.ffmpegDetail || err?.message);
    }
   }

   // Giải phóng ngay file video gốc (tới 45MB) trên đĩa trước khi đọc buffer GIF kết quả vào RAM!
   await fsp.unlink(inputPath).catch(() => {});

   if (!rendered) {
    throw new Error(
     lastPass2Err?.message?.includes('Ổ đĩa')
      ? lastPass2Err.message
      : 'Không thể xuất ảnh GIF từ video này — tệp video có thể bị hỏng hoặc thiếu bộ nhớ tạm thời, hãy thử đoạn ngắn 4–6 giây nhé!',
    );
   }
   if (rendered.bytes > uploadCap) {
    await fsp.unlink(rendered.outputPath).catch(() => {});
    throw new Error('Ảnh GIF tạo ra vẫn vượt giới hạn dung lượng của Discord — hãy giảm độ dài (duration) xuống khoảng 4–6 giây nhé!');
   }

   const gifBuffer = await fsp.readFile(rendered.outputPath);
   await fsp.unlink(rendered.outputPath).catch(() => {});

   const savedDuration = Number(effectiveOpts.durationSec.toFixed(2));
   const session = saveTuneSession({
    token: existingToken,
    sourceUrl: normalizeCandidateVideoUrl(sourceUrl),
    requesterId: String(requesterId ?? ''),
    startSec: opts.startSec,
    durationSec: Math.max(MIN_DURATION_SEC, Math.min(MAX_DURATION_SEC, savedDuration)),
    speed: opts.speed,
    caption: opts.caption,
    captionStyle: opts.captionStyle,
    quality: opts.quality === 'auto' ? 'auto' : rendered.presetKey,
    fps: opts.fps !== null ? rendered.fps : null,
   });

   const nativeTarget = computeScaledDimensions(probe.width, probe.height, GIF_QUALITY_PRESETS.auto);
   const isNativeMax = opts.quality === 'auto'
    && rendered.width === nativeTarget.width
    && (rendered.height - rendered.padTop) === nativeTarget.height
    && rendered.fps >= Math.min(50, nativeMaxFps);

   const outputDurationSec = Number(Math.max(0.2, effectiveOpts.durationSec / opts.speed).toFixed(1));
   const meta = {
    bytes: gifBuffer.length,
    width: rendered.width,
    height: rendered.height,
    sourceWidth: probe.width,
    sourceHeight: probe.height,
    sourceFps: probe.fps,
    fps: rendered.fps,
    startSec: opts.startSec,
    durationSec: effectiveOpts.durationSec,
    outputDurationSec,
    speed: opts.speed,
    caption: opts.caption,
    captionStyle: opts.captionStyle,
    quality: rendered.qualityKey,
    isNativeMax,
    autoSteppedDown: usedIdx > 0 || skippedForBudget > 0,
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
