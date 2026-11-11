import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import dns from 'node:dns/promises';
import { createWriteStream } from 'node:fs';
import fsPromises from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { StreamType } from '@discordjs/voice';

// Giới hạn an toàn cho máy chủ 512MB RAM: chỉ đọc luồng từng mảnh nhỏ (~64 KB), tuyệt đối không nạp cả file vào RAM!
export const MAX_MEDIA_FILE_BYTES = 250 * 1024 * 1024; // Tối đa 250 MiB dung lượng tệp nguồn
export const MAX_MEDIA_DURATION_MS = 180 * 60 * 1000;  // Tối đa 180 phút (đồng bộ chính sách toàn bot)

export const SUPPORTED_AUDIO_EXTS = new Set([
 '.mp3',
 '.m4a',
 '.aac',
 '.wav',
 '.flac',
 '.ogg',
 '.oga',
 '.opus',
 '.weba',
 '.wma',
]);

export const SUPPORTED_VIDEO_EXTS = new Set([
 '.mp4',
 '.mov',
 '.webm',
 '.mkv',
 '.m4v',
 '.avi',
 '.mpeg',
 '.mpg',
 '.ts',
 '.3gp',
]);

const BLOCKED_EXTS = new Set([
 '.m3u8',
 '.mpd',
 '.pls',
 '.exe',
 '.msi',
 '.bat',
 '.cmd',
 '.sh',
 '.zip',
 '.rar',
 '.7z',
 '.tar',
 '.gz',
 '.iso',
 '.apk',
 '.png',
 '.jpg',
 '.jpeg',
 '.gif',
 '.webp',
 '.bmp',
 '.svg',
 '.pdf',
 '.doc',
 '.docx',
 '.xls',
 '.xlsx',
 '.ppt',
 '.pptx',
 '.html',
 '.htm',
 '.js',
 '.mjs',
 '.cjs',
 '.json',
 '.txt',
]);

const STREAMING_PLATFORM_HOSTS = new Set([
 'youtube.com',
 'www.youtube.com',
 'm.youtube.com',
 'music.youtube.com',
 'youtu.be',
 'soundcloud.com',
 'www.soundcloud.com',
 'm.soundcloud.com',
 'on.soundcloud.com',
 'open.spotify.com',
 'spotify.link',
]);

const TRUSTED_DISCORD_CDN_HOSTS = new Set([
 'cdn.discordapp.com',
 'media.discordapp.net',
]);

function parseIpv4Octets(ipv4) {
 const parts = String(ipv4 ?? '').trim().split('.');
 if (parts.length !== 4) return null;
 const nums = parts.map(p => (/^\d{1,3}$/.test(p) ? Number(p) : NaN));
 if (nums.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return null;
 return nums;
}

// Chặn triệt để IP nội bộ / Loopback / Link-Local / Metadata đám mây (cả IPv4 lẫn IPv6 ánh xạ ::ffff:).
export function isPrivateOrReservedIp(rawIp) {
 const ip = String(rawIp ?? '').trim().toLowerCase().replace(/^\[|\]$/g, '');
 if (!ip) return true;

 const family = net.isIP(ip);
 if (family === 4) {
  const octets = parseIpv4Octets(ip);
  if (!octets) return true;
  const [a, b] = octets;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a >= 224) return true;
  return false;
 }

 if (family === 6) {
  if (ip === '::' || ip === '::1') return true;
  if (ip.startsWith('fc') || ip.startsWith('fd')) return true; // fc00::/7 Unique Local
  if (/^fe[89ab]/i.test(ip)) return true; // fe80::/10 Link-Local
  if (ip.startsWith('ff')) return true; // Multicast
  if (ip.startsWith('2001:db8:')) return true;

  // Kiểm tra địa chỉ IPv4 nhúng trong IPv6 dạng ::ffff:127.0.0.1 hoặc ::ffff:7f00:1
  const v4MappedMatch = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (v4MappedMatch) {
   return isPrivateOrReservedIp(v4MappedMatch[1]);
  }
  const v4HexMatch = ip.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (v4HexMatch) {
   const hi = Number.parseInt(v4HexMatch[1], 16);
   const lo = Number.parseInt(v4HexMatch[2], 16);
   const mappedV4 = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
   return isPrivateOrReservedIp(mappedV4);
  }
  return false;
 }

 return true;
}

export function isTrustedDiscordMediaHost(hostname) {
 return TRUSTED_DISCORD_CDN_HOSTS.has(String(hostname ?? '').toLowerCase().trim());
}

export function extractFileExtensionFromUrl(rawUrlOrName = '') {
 try {
  const str = String(rawUrlOrName ?? '').trim();
  const pathPart = /^https?:\/\//i.test(str) ? new URL(str).pathname : str.split('?')[0];
  const decoded = decodeURIComponent(pathPart);
  const lastSegment = decoded.split('/').pop() ?? '';
  const dotIdx = lastSegment.lastIndexOf('.');
  if (dotIdx <= 0) return '';
  return lastSegment.slice(dotIdx).toLowerCase();
 } catch {
  return '';
 }
}

export function classifyMediaFileType(ext = '', mimeType = '') {
 const cleanExt = String(ext ?? '').toLowerCase().trim();
 const cleanMime = String(mimeType ?? '').toLowerCase().split(';')[0].trim();

 if (BLOCKED_EXTS.has(cleanExt)) {
  return { supported: false, isVideo: false, mime: cleanMime };
 }
 if (
  cleanMime.startsWith('image/') ||
  cleanMime.startsWith('text/') ||
  cleanMime === 'application/vnd.apple.mpegurl' ||
  cleanMime === 'application/x-mpegurl' ||
  cleanMime === 'application/dash+xml'
 ) {
  return { supported: false, isVideo: false, mime: cleanMime };
 }

 if (SUPPORTED_VIDEO_EXTS.has(cleanExt) || cleanMime.startsWith('video/')) {
  return {
   supported: true,
   isVideo: true,
   mime: cleanMime.startsWith('video/') || cleanMime.startsWith('audio/') ? cleanMime : inferMimeFromExt(cleanExt),
  };
 }

 if (
  SUPPORTED_AUDIO_EXTS.has(cleanExt) ||
  cleanMime.startsWith('audio/') ||
  cleanMime === 'application/ogg'
 ) {
  return {
   supported: true,
   isVideo: false,
   mime: cleanMime.startsWith('audio/') || cleanMime === 'application/ogg' ? cleanMime : inferMimeFromExt(cleanExt),
  };
 }

 return { supported: false, isVideo: false, mime: cleanMime };
}

export function inferMimeFromExt(ext = '') {
 switch (String(ext).toLowerCase()) {
  case '.mp3':
   return 'audio/mpeg';
  case '.m4a':
  case '.aac':
   return 'audio/mp4';
  case '.wav':
   return 'audio/wav';
  case '.flac':
   return 'audio/flac';
  case '.ogg':
  case '.oga':
  case '.opus':
   return 'audio/ogg';
  case '.webm':
  case '.weba':
   return 'audio/webm';
  case '.mp4':
  case '.m4v':
  case '.mov':
   return 'video/mp4';
  default:
   return 'audio/mpeg';
 }
}

export function isDirectMediaFileUrl(rawUrl) {
 if (typeof rawUrl !== 'string') return false;
 const trimmed = rawUrl.trim();
 if (!trimmed || trimmed.length > 2048 || !/^https?:\/\//i.test(trimmed)) return false;
 try {
  const parsed = new URL(trimmed);
  const host = parsed.hostname.toLowerCase();
  if (STREAMING_PLATFORM_HOSTS.has(host)) return false;
  const ext = extractFileExtensionFromUrl(parsed.pathname);
  if (SUPPORTED_AUDIO_EXTS.has(ext) || SUPPORTED_VIDEO_EXTS.has(ext)) return true;
  if (isTrustedDiscordMediaHost(host) && parsed.pathname.startsWith('/attachments/')) {
   return !BLOCKED_EXTS.has(ext);
  }
  return false;
 } catch {
  return false;
 }
}

// Làm đẹp tên bài hát tự động từ tên tệp tải lên (giữ nguyên dấu tiếng Việt, bỏ đuôi .mp3/.mp4 và gạch dưới).
export function prettifyMediaFilename(rawName = '') {
 let name = String(rawName ?? '').trim();
 try {
  if (/^https?:\/\//i.test(name)) {
   const u = new URL(name);
   name = decodeURIComponent(u.pathname.split('/').pop() || '');
  } else {
   name = decodeURIComponent(name);
  }
 } catch {}

 name = name
  .replace(/\.[a-zA-Z0-9]{2,5}$/, '')
  .replace(/[_]+/g, ' ')
  .replace(/\s{2,}/g, ' ')
  .trim();

 if (!name || name.length < 2) return 'Bản nhạc từ tệp tải lên';
 return name.slice(0, 110);
}

// Tự động xin lại chữ ký CDN mới từ Discord nếu tệp đính kèm lưu trong Tủ nhạc / Phiên cũ đã quá hạn 24 giờ.
export async function refreshDiscordAttachmentUrlIfNeeded(rawUrl, discordRest = null, nowMs = Date.now()) {
 if (!rawUrl || !discordRest || typeof discordRest.post !== 'function') return rawUrl;
 try {
  const parsed = new URL(rawUrl);
  if (!isTrustedDiscordMediaHost(parsed.hostname)) return rawUrl;
  const exHex = parsed.searchParams.get('ex');
  if (!exHex || !/^[0-9a-f]+$/i.test(exHex)) return rawUrl;
  const expMs = Number.parseInt(exHex, 16) * 1000;
  if (!Number.isFinite(expMs) || expMs > nowMs + 20 * 60_000) {
   return rawUrl;
  }
  const resp = await discordRest.post('/attachments/refresh-urls', {
   body: { attachment_urls: [rawUrl] },
  });
  const refreshed = resp?.refreshed_urls?.[0]?.refreshed;
  if (typeof refreshed === 'string' && refreshed.startsWith('https://')) {
   return refreshed;
  }
 } catch {}
 return rawUrl;
}

async function assertSafeHostname(hostname, dnsLookup = dns.lookup) {
 const cleanHost = String(hostname ?? '').trim().toLowerCase().replace(/^\[|\]$/g, '');
 if (
  !cleanHost ||
  cleanHost === 'localhost' ||
  cleanHost.endsWith('.localhost') ||
  cleanHost.endsWith('.local') ||
  cleanHost.endsWith('.internal') ||
  cleanHost.endsWith('.arpa')
 ) {
  throw new Error('Đường dẫn tệp không hợp lệ hoặc trỏ tới mạng nội bộ bị chặn.');
 }

 if (net.isIP(cleanHost)) {
  if (isPrivateOrReservedIp(cleanHost)) {
   throw new Error('Đường dẫn tệp trỏ tới địa chỉ IP nội bộ bị chặn.');
  }
  return;
 }

 let records;
 try {
  records = await dnsLookup(cleanHost, { all: true, verbatim: true });
 } catch {
  throw new Error('Không phân giải được tên miền của đường dẫn tệp.');
 }
 if (!Array.isArray(records) || records.length === 0) {
  throw new Error('Không phân giải được địa chỉ máy chủ của đường dẫn tệp.');
 }
 for (const rec of records) {
  if (isPrivateOrReservedIp(rec?.address)) {
   throw new Error('Đường dẫn tệp trỏ tới địa chỉ IP nội bộ bị chặn.');
  }
 }
}

// Kiểm tra an toàn SSRF qua từng chặng chuyển hướng (tối đa 3 chặng) & đọc nhanh tiêu đề HTTP mà không tải tệp vào RAM.
export async function assertAndProbeRemoteMediaUrl(
 rawUrl,
 { fetchImpl = fetch, dnsLookup = dns.lookup, signal = null } = {},
) {
 const trimmed = String(rawUrl ?? '').trim();
 if (!trimmed || trimmed.length > 2048) {
  throw new Error('Đường dẫn tệp quá dài hoặc bị bỏ trống.');
 }

 let currentUrl;
 try {
  currentUrl = new URL(trimmed);
 } catch {
  throw new Error('Đường dẫn tệp không đúng định dạng `https://...`.');
 }

 for (let hop = 0; hop <= 3; hop++) {
  if (currentUrl.protocol !== 'https:' && currentUrl.protocol !== 'http:') {
   throw new Error('Chỉ hỗ trợ đường dẫn tệp giao thức `https://` hoặc `http://`.');
  }
  if (currentUrl.username || currentUrl.password) {
   throw new Error('Đường dẫn tệp không được chứa thông tin đăng nhập.');
  }
  const hostLower = currentUrl.hostname.toLowerCase();
  if (STREAMING_PLATFORM_HOSTS.has(hostLower)) {
   throw new Error('Link YouTube / SoundCloud / Spotify hãy dùng lệnh `/play` nhé! Lệnh `/playfile` dành riêng cho tệp nhạc hoặc video.');
  }

  await assertSafeHostname(hostLower, dnsLookup);

  const probeSignal = signal
   ? AbortSignal.any([signal, AbortSignal.timeout(9000)])
   : AbortSignal.timeout(9000);

  const res = await fetchImpl(currentUrl.toString(), {
   method: 'GET',
   redirect: 'manual',
   headers: {
    Range: 'bytes=0-0',
    'User-Agent': 'BatDonMusicBot/1.0',
   },
   signal: probeSignal,
  });

  if (res.status >= 300 && res.status < 400) {
   try {
    await res.body?.cancel?.();
   } catch {}
   if (hop >= 3) {
    throw new Error('Đường dẫn tệp chuyển hướng quá nhiều lần.');
   }
   const loc = res.headers.get('location');
   if (!loc) {
    throw new Error('Đường dẫn tệp chuyển hướng không hợp lệ.');
   }
   currentUrl = new URL(loc, currentUrl);
   continue;
  }

  try {
   await res.body?.cancel?.();
  } catch {}

  if (!res.ok && res.status !== 206) {
   throw new Error(`Không truy cập được tệp nhạc/video (mã HTTP ${res.status}).`);
  }

  const contentRange = res.headers.get('content-range') ?? '';
  const rangeTotalMatch = contentRange.match(/\/(\d+)\s*$/);
  const contentLength = rangeTotalMatch
   ? Number(rangeTotalMatch[1])
   : Number(res.headers.get('content-length') ?? 0);

  if (Number.isFinite(contentLength) && contentLength > MAX_MEDIA_FILE_BYTES) {
   throw new Error('Dung lượng tệp vượt quá giới hạn an toàn 250 MB.');
  }

  const contentType = res.headers.get('content-type') ?? '';
  const ext = extractFileExtensionFromUrl(currentUrl.pathname);
  const kind = classifyMediaFileType(ext, contentType);
  if (!kind.supported) {
   throw new Error(
    'Định dạng tệp không hỗ trợ! Hãy chọn tệp nhạc (`.mp3`, `.m4a`, `.wav`, `.flac`, `.ogg`, `.aac`) hoặc video (`.mp4`, `.mov`, `.webm`, `.mkv`).',
   );
  }

  return {
   finalUrl: currentUrl.toString(),
   isTrustedCdn: isTrustedDiscordMediaHost(currentUrl.hostname),
   isVideo: kind.isVideo,
   mime: kind.mime,
   byteLength: Number.isFinite(contentLength) && contentLength > 0 ? contentLength : 0,
  };
 }

 throw new Error('Không thể xác minh đường dẫn tệp.');
}

function parseFfmpegDurationMs(stderrText = '', byteLength = 0) {
 const text = String(stderrText);
 const m = text.match(/Duration:\s*(\d{2,3}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?/i);
 if (m) {
  const hours = Number.parseInt(m[1], 10);
  const mins = Number.parseInt(m[2], 10);
  const secs = Number.parseInt(m[3], 10);
  const ms = m[4] ? Number.parseInt(m[4].padEnd(3, '0').slice(0, 3), 10) : 0;
  return (hours * 3600 + mins * 60 + secs) * 1000 + ms;
 }
 // Trường hợp tệp MP3 CBR đọc qua pipe:0 hiện "Duration: N/A ... bitrate: 128 kb/s" -> tính từ dung lượng byte gốc.
 if (byteLength > 0) {
  const brMatch = text.match(/bitrate:\s*(\d+)\s*kb\/s/i) ?? text.match(/(\d+)\s*kb\/s/i);
  const kbps = brMatch ? Number.parseInt(brMatch[1], 10) : 0;
  if (kbps > 0) {
   return Math.round((byteLength * 8) / kbps);
  }
 }
 return 0;
}

// Đo nhanh thời lượng tệp bằng phần đầu thông tin (không tải cả tệp về máy, mất ~0.15s).
export async function probeMediaDurationMs(
 ffmpegPath,
 finalUrl,
 { isTrustedCdn = false, byteLength = 0, fetchImpl = fetch } = {},
) {
 if (!ffmpegPath) return 0;

 if (isTrustedCdn) {
  return new Promise(resolve => {
   const proc = spawn(
    ffmpegPath,
    [
     '-hide_banner',
     '-vn',
     '-rw_timeout',
     '6000000',
     '-seekable',
     '1',
     '-i',
     finalUrl,
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
   );
   let stderr = '';
   const timer = setTimeout(() => {
    try {
     proc.kill('SIGKILL');
    } catch {}
    resolve(0);
   }, 6500);
   timer.unref?.();

   proc.stderr.on('data', chunk => {
    if (stderr.length < 16_384) stderr += chunk.toString('utf8');
   });
   proc.on('error', () => {
    clearTimeout(timer);
    resolve(0);
   });
   proc.on('close', () => {
    clearTimeout(timer);
    resolve(parseFfmpegDurationMs(stderr, byteLength));
   });
  });
 }

 // Với tên miền ngoài Discord: chỉ tải tối đa 512 KB đầu qua fetch(redirect: 'error') bơm vào pipe:0 để chống chuyển hướng SSRF tuyệt đối!
 try {
  const res = await fetchImpl(finalUrl, {
   method: 'GET',
   redirect: 'error',
   headers: { Range: 'bytes=0-524287', 'User-Agent': 'BatDonMusicBot/1.0' },
   signal: AbortSignal.timeout(6500),
  });
  if (!res.ok && res.status !== 206) return 0;
  const chunks = [];
  let total = 0;
  if (res.body) {
   for await (const chunk of res.body) {
    const buf = Buffer.from(chunk);
    chunks.push(buf);
    total += buf.length;
    if (total >= 524_288) {
     try {
      await res.body.cancel();
     } catch {}
     break;
    }
   }
  }
  const headBuf = Buffer.concat(chunks);
  if (!headBuf.length) return 0;

  return await new Promise(resolve => {
   const proc = spawn(ffmpegPath, ['-hide_banner', '-vn', '-i', 'pipe:0'], {
    stdio: ['pipe', 'ignore', 'pipe'],
   });
   let stderr = '';
   const timer = setTimeout(() => {
    try {
     proc.kill('SIGKILL');
    } catch {}
    resolve(0);
   }, 5000);
   timer.unref?.();

   proc.stdin.on('error', () => {});
   proc.stderr.on('data', c => {
    if (stderr.length < 16_384) stderr += c.toString('utf8');
   });
   proc.on('error', () => {
    clearTimeout(timer);
    resolve(0);
   });
   proc.on('close', () => {
    clearTimeout(timer);
    resolve(parseFfmpegDurationMs(stderr, byteLength));
   });
   proc.stdin.end(headBuf);
  });
 } catch {
  return 0;
 }
}

// Xác thực tệp đính kèm hoặc link tệp từ lệnh /playfile và đóng gói thành đối tượng Track chuẩn của Bot.
export async function resolvePlayFileTrack(
 {
  attachment = null,
  rawUrl = '',
  customTitle = '',
  requestedBy = 'Unknown',
  uploaderName = '',
 } = {},
 {
  ffmpegPath = 'ffmpeg',
  fetchImpl = fetch,
  dnsLookup = dns.lookup,
 } = {},
) {
 if (!attachment && !String(rawUrl ?? '').trim()) {
  throw new Error('Hãy đính kèm 1 tệp nhạc/video vào ô `file` hoặc dán đường dẫn tệp vào ô `url`!');
 }

 let targetUrl = '';
 let rawFileName = '';
 let hintedDurationMs = 0;

 if (attachment) {
  const attSize = Number(attachment.size ?? 0);
  if (attSize > MAX_MEDIA_FILE_BYTES) {
   throw new Error('Dung lượng tệp tải lên vượt quá giới hạn an toàn 250 MB.');
  }
  const ext = extractFileExtensionFromUrl(attachment.name || attachment.url || '');
  const check = classifyMediaFileType(ext, attachment.contentType || '');
  if (!check.supported) {
   throw new Error(
    'Tệp đính kèm không phải nhạc hoặc video hỗ trợ! Hãy chọn `.mp3`, `.m4a`, `.wav`, `.flac`, `.ogg`, `.mp4`, `.mov`, `.webm` hoặc `.mkv`.',
   );
  }
  targetUrl = String(attachment.url || attachment.proxyURL || '').trim();
  rawFileName = String(attachment.name || '').trim();
  if (Number.isFinite(attachment.duration) && attachment.duration > 0) {
   hintedDurationMs = Math.round(Number(attachment.duration) * 1000);
  }
 } else {
  targetUrl = String(rawUrl).trim();
  rawFileName = targetUrl;
 }

 const probed = await assertAndProbeRemoteMediaUrl(targetUrl, { fetchImpl, dnsLookup });
 const durationMs =
  hintedDurationMs > 0
   ? hintedDurationMs
   : await probeMediaDurationMs(ffmpegPath, probed.finalUrl, {
      isTrustedCdn: probed.isTrustedCdn,
      byteLength: probed.byteLength || Number(attachment?.size ?? 0) || 0,
      fetchImpl,
     });

 if (durationMs > MAX_MEDIA_DURATION_MS) {
  throw new Error('Chỉ nhận tệp nhạc / video tối đa 180 phút.');
 }

 const cleanCustom = String(customTitle ?? '').replace(/\s+/g, ' ').trim().slice(0, 110);
 const displayTitle = cleanCustom || prettifyMediaFilename(rawFileName || probed.finalUrl);
 const kindBadge = probed.isVideo ? 'Video tách tiếng' : 'Tệp âm thanh';
 const authorLabel = uploaderName
  ? `${uploaderName} • ${kindBadge}`
  : kindBadge;
 const idHash = createHash('sha1').update(probed.finalUrl.split('?')[0]).digest('hex').slice(0, 14);

 return {
  id: `file-${idHash}`,
  title: displayTitle,
  url: probed.finalUrl,
  duration: durationMs,
  thumbnail: undefined,
  requestedBy: String(requestedBy || 'Unknown'),
  source: 'file',
  metadata: {
   author: authorLabel,
   isVideoFile: probed.isVideo,
   mimeType: probed.mime,
   fileSize: probed.byteLength || Number(attachment?.size ?? 0) || 0,
  },
 };
}

// Tạo Plugin đọc luồng âm thanh/video trực tiếp siêu nhẹ (< 3 MB RAM, tách bỏ hình ảnh -vn, hỗ trợ /seek tức thì).
export function createMediaFilePlugin({
 ffmpegPath = 'ffmpeg',
 getDiscordRest = null,
 onTrackMetaSynced = null,
 fetchImpl = fetch,
 dnsLookup = dns.lookup,
} = {}) {
 async function openMediaFilePcmStream(track, { signal = null, seekMs = 0 } = {}) {
  const discordRest = typeof getDiscordRest === 'function' ? getDiscordRest() : null;
  const currentRawUrl = String(track?.url ?? '').trim();
  if (!currentRawUrl) {
   throw new Error('Không tìm thấy đường dẫn tệp âm thanh/video.');
  }

  const maybeRefreshed = await refreshDiscordAttachmentUrlIfNeeded(currentRawUrl, discordRest);
  if (maybeRefreshed && maybeRefreshed !== currentRawUrl && track) {
   track.url = maybeRefreshed;
  }

  const probed = await assertAndProbeRemoteMediaUrl(track?.url ?? maybeRefreshed, {
   fetchImpl,
   dnsLookup,
   signal,
  });

  if (track && (!Number(track.duration) || Number(track.duration) <= 0)) {
   const measured = await probeMediaDurationMs(ffmpegPath, probed.finalUrl, {
    isTrustedCdn: probed.isTrustedCdn,
    byteLength: probed.byteLength || 0,
    fetchImpl,
   });
   if (measured > MAX_MEDIA_DURATION_MS) {
    throw new Error('Chỉ nhận tệp nhạc / video tối đa 180 phút.');
   }
   if (measured > 0) {
    track.duration = measured;
    onTrackMetaSynced?.(track);
   }
  }

  const totalDur = Number(track?.duration) || 0;
  const clampedSeekMs = Math.max(
   0,
   totalDur > 2000 ? Math.min(Math.floor(Number(seekMs) || 0), totalDur - 1200) : Math.floor(Number(seekMs) || 0),
  );
  const seekSec = clampedSeekMs >= 300 ? clampedSeekMs / 1000 : 0;

  let ffProc = null;
  let fetchAbort = null;
  let upstreamNodeStream = null;
  let tempDiskPath = null;
  let cleanedUp = false;

  const outStream = new PassThrough({ highWaterMark: 32 * 1024 });
  outStream.inputType = StreamType.Raw;

  const cleanup = () => {
   if (cleanedUp) return;
   cleanedUp = true;
   const procToKill = ffProc;
   const abortToRun = fetchAbort;
   const upToDestroy = upstreamNodeStream;
   const tmpToRemove = tempDiskPath;
   ffProc = null;
   fetchAbort = null;
   upstreamNodeStream = null;
   tempDiskPath = null;
   setImmediate(() => {
    try {
     abortToRun?.abort?.();
    } catch {}
    try {
     upToDestroy?.destroy?.();
    } catch {}
    try {
     if (procToKill && !procToKill.killed) procToKill.kill('SIGKILL');
    } catch {}
    if (tmpToRemove) {
     void fsPromises.rm(tmpToRemove, { force: true }).catch(() => {});
    }
   });
  };

  outStream.once('close', cleanup);
  outStream.once('error', cleanup);
  if (signal) {
   if (signal.aborted) {
    cleanup();
    throw new Error('Đã hủy tải luồng tệp.');
   }
   signal.addEventListener(
    'abort',
    () => {
     cleanup();
     outStream.destroy();
    },
    { once: true },
   );
  }

  if (probed.isTrustedCdn) {
   const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-reconnect',
    '1',
    '-reconnect_streamed',
    '1',
    '-reconnect_delay_max',
    '3',
    '-rw_timeout',
    '15000000',
    '-seekable',
    '1',
    ...(seekSec > 0 ? ['-ss', seekSec.toFixed(3)] : []),
    '-vn',
    '-i',
    probed.finalUrl,
    '-af',
    'aresample=48000:resampler=soxr:precision=24',
    '-f',
    's16le',
    '-ar',
    '48000',
    '-ac',
    '2',
    'pipe:1',
   ];
   ffProc = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  } else {
   const extLower = extractFileExtensionFromUrl(probed.finalUrl);
   const needsSeekableContainer =
    extLower === '.mp4' ||
    extLower === '.mov' ||
    extLower === '.m4a' ||
    extLower === '.m4v' ||
    extLower === '.3gp' ||
    probed.mime === 'video/mp4' ||
    probed.mime === 'video/quicktime' ||
    probed.mime === 'audio/mp4';

   fetchAbort = new AbortController();
   const res = await fetchImpl(probed.finalUrl, {
    method: 'GET',
    redirect: 'error',
    headers: { 'User-Agent': 'BatDonMusicBot/1.0' },
    signal: signal ? AbortSignal.any([signal, fetchAbort.signal]) : fetchAbort.signal,
   });
   if (!res.ok || !res.body) {
    cleanup();
    throw new Error(`Không mở được luồng tệp âm thanh/video (HTTP ${res.status}).`);
   }

   if (needsSeekableContainer) {
    // Tệp MP4/MOV/M4A ngoài Discord thường để bảng chỉ mục moov ở cuối tệp (như video quay từ iPhone) -> ghi luồng 64KB xuống ổ tạm rồi xóa ngay khi hát xong, tốn 0 MB bộ nhớ đệm RAM!
    const maxExternalSpoolBytes = 80 * 1024 * 1024;
    if (probed.byteLength > maxExternalSpoolBytes) {
     cleanup();
     throw new Error('Link video MP4/MOV ngoài Discord chỉ hỗ trợ tối đa 80 MB (tải trực tiếp lên ô file của /playfile để hỗ trợ tới 250 MB).');
    }
    tempDiskPath = path.join(os.tmpdir(), `batdon-media-${randomBytes(6).toString('hex')}${extLower || '.mp4'}`);
    const fileOut = createWriteStream(tempDiskPath, { highWaterMark: 64 * 1024 });
    let written = 0;
    try {
     for await (const rawChunk of res.body) {
      const buf = Buffer.from(rawChunk);
      written += buf.length;
      if (written > maxExternalSpoolBytes) {
       throw new Error('Dung lượng link video ngoài Discord vượt quá giới hạn 80 MB.');
      }
      if (!fileOut.write(buf)) {
       await new Promise(r => fileOut.once('drain', r));
      }
     }
     await new Promise((resolve, reject) => {
      fileOut.end();
      fileOut.once('finish', resolve);
      fileOut.once('error', reject);
     });
    } catch (spoolErr) {
     try {
      fileOut.destroy();
     } catch {}
     cleanup();
     throw spoolErr;
    }

    const args = [
     '-hide_banner',
     '-loglevel',
     'info',
     ...(seekSec > 0 ? ['-ss', seekSec.toFixed(3)] : []),
     '-vn',
     '-i',
     tempDiskPath,
     '-af',
     'aresample=48000:resampler=soxr:precision=24',
     '-f',
     's16le',
     '-ar',
     '48000',
     '-ac',
     '2',
     'pipe:1',
    ];
    ffProc = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
   } else {
    upstreamNodeStream = Readable.fromWeb(res.body, { highWaterMark: 64 * 1024 });
    const args = [
     '-hide_banner',
     '-loglevel',
     'error',
     '-vn',
     '-i',
     'pipe:0',
     ...(seekSec > 0 ? ['-ss', seekSec.toFixed(3)] : []),
     '-af',
     'aresample=48000:resampler=soxr:precision=24',
     '-f',
     's16le',
     '-ar',
     '48000',
     '-ac',
     '2',
     'pipe:1',
    ];
    ffProc = spawn(ffmpegPath, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    ffProc.stdin.on('error', () => {});
    upstreamNodeStream.on('error', () => cleanup());
    upstreamNodeStream.pipe(ffProc.stdin);
   }
  }

  let gotAudioBytes = false;
  let stderrMsg = '';

  ffProc.stderr.on('data', chunk => {
   if (stderrMsg.length < 4096) {
    stderrMsg += chunk.toString('utf8');
    if (track && (!Number(track.duration) || Number(track.duration) <= 0)) {
     const dMs = parseFfmpegDurationMs(stderrMsg, probed.byteLength || 0);
     if (dMs > 0 && dMs <= MAX_MEDIA_DURATION_MS) {
      track.duration = dMs;
      onTrackMetaSynced?.(track);
     }
    }
   }
  });

  ffProc.stdout.on('data', chunk => {
   gotAudioBytes = true;
   if (!outStream.destroyed && !outStream.writableEnded) {
    if (!outStream.write(chunk)) {
     ffProc?.stdout?.pause?.();
    }
   }
  });

  outStream.on('drain', () => {
   ffProc?.stdout?.resume?.();
  });

  ffProc.on('error', err => {
   cleanup();
   if (!outStream.destroyed) outStream.destroy(err);
  });

  ffProc.on('close', code => {
   if (!cleanedUp) cleanup();
   if (!outStream.destroyed && !outStream.writableEnded) {
    if (code !== 0 && !gotAudioBytes) {
     const friendlyMsg = /does not contain any stream/i.test(stderrMsg)
      ? 'Tệp video này không chứa rãnh tiếng (video câm), không thể phát nhạc.'
      : 'Tệp bị lỗi định dạng hoặc không có kênh âm thanh hợp lệ để phát.';
     outStream.destroy(new Error(friendlyMsg));
    } else {
     outStream.end();
    }
   }
  });

  // Chờ mảnh PCM đầu tiên (tối đa 8 giây) để đảm bảo 100% tệp thực sự có tiếng trước khi báo đang phát!
  await new Promise((resolve, reject) => {
   const waitTimer = setTimeout(() => {
    cleanup();
    outStream.destroy();
    reject(new Error('Quá thời gian đọc âm thanh từ tệp này.'));
   }, 8500);
   waitTimer.unref?.();

   const onFirstReadable = () => {
    if (!gotAudioBytes && outStream.readableLength === 0) return;
    clearTimeout(waitTimer);
    outStream.off('readable', onFirstReadable);
    outStream.off('error', onEarlyErr);
    outStream.off('end', onEarlyEnd);
    resolve();
   };
   const onEarlyErr = err => {
    clearTimeout(waitTimer);
    outStream.off('readable', onFirstReadable);
    outStream.off('end', onEarlyEnd);
    reject(err);
   };
   const onEarlyEnd = () => {
    clearTimeout(waitTimer);
    outStream.off('readable', onFirstReadable);
    outStream.off('error', onEarlyErr);
    if (gotAudioBytes) resolve();
    else reject(new Error('Tệp video/âm thanh này không chứa rãnh tiếng (audio track) nào để phát.'));
   };

   if (outStream.readableLength > 0) {
    clearTimeout(waitTimer);
    resolve();
    return;
   }
   outStream.once('readable', onFirstReadable);
   outStream.once('error', onEarlyErr);
   outStream.once('end', onEarlyEnd);
  });

  return outStream;
 }

 return {
  name: 'file',
  version: '1.0.0',
  priority: 40,

  validate(url) {
   return isDirectMediaFileUrl(url);
  },

  canHandle(query) {
   return isDirectMediaFileUrl(query);
  },

  async search(query, requestedBy) {
   const trimmed = String(query ?? '').trim();
   if (!isDirectMediaFileUrl(trimmed)) return { tracks: [] };
   const discordRest = typeof getDiscordRest === 'function' ? getDiscordRest() : null;
   const refreshed = await refreshDiscordAttachmentUrlIfNeeded(trimmed, discordRest);
   const track = await resolvePlayFileTrack(
    { rawUrl: refreshed, requestedBy },
    { ffmpegPath, fetchImpl, dnsLookup },
   );
   return { tracks: [track] };
  },

  async getStream(track, signal) {
   const stream = await openMediaFilePcmStream(track, { signal, seekMs: 0 });
   return {
    stream,
    type: 'raw',
    inputType: StreamType.Raw,
    recreate: positionMs => openMediaFilePcmStream(track, { seekMs: positionMs }),
    metadata: {
     title: track?.title,
     author: track?.metadata?.author,
    },
   };
  },

  async getRelatedTracks() {
   return [];
  },
 };
}
