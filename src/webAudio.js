// Thời gian làm mới chữ ký luồng nhạc Web trước khi playlist.m3u8 hết hạn (~6 phút TTL của CloudFront).
export const WEB_AUDIO_REFRESH_MS = 210_000; // 3 phút 30 giây

const ALLOWED_AUDIO_HOST_SUFFIXES = [
 '.soundcloud.cloud',
 '.sndcdn.com',
 '.soundcloud.com',
 'soundcloud.com',
];

const detailsCache = new Map();
const MAX_DETAILS_CACHE = 24;

// Kiểm tra URL luồng âm thanh dài tới 2048 ký tự (chữ ký CloudFront RSA-2048 của SoundCloud dài ~750-900 ký tự, vượt mốc 512 của nút Discord).
function safeStreamUrl(rawUrl, maxLen = 2048) {
 if (typeof rawUrl !== 'string' || !rawUrl.trim() || rawUrl.length > maxLen) return null;
 try {
  const parsed = new URL(rawUrl.trim());
  return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.toString() : null;
 } catch {
  return null;
 }
}

export function isAllowedWebAudioUrl(rawUrl) {
 const clean = safeStreamUrl(rawUrl);
 if (!clean) return false;
 try {
  const host = new URL(clean).hostname.toLowerCase();
  return ALLOWED_AUDIO_HOST_SUFFIXES.some(suffix =>
   suffix.startsWith('.') ? host.endsWith(suffix) : host === suffix,
  );
 } catch {
  return false;
 }
}

// Chọn định dạng luồng SoundCloud tương thích tốt nhất với trình duyệt Web (ưu tiên fMP4 AAC HLS -> Progressive MP3 -> HLS khác).
export function pickWebPlayableTranscoding(transcodings = []) {
 if (!Array.isArray(transcodings)) return null;
 const valid = transcodings.filter(t => t && !t.snipped && t.url && t.format?.protocol);

 const fmp4Candidates = valid.filter(
  t => t.format.protocol === 'hls' && /mp4/i.test(String(t.format.mime_type ?? '')),
 );
 if (fmp4Candidates.length > 0) {
  // Ưu tiên bản chất lượng cao hơn (ví dụ aac_160k / hq) nếu có.
  return (
   fmp4Candidates.find(t => t.quality === 'hq' || /160k|256k/i.test(String(t.preset ?? ''))) ??
   fmp4Candidates[0]
  );
 }

 const progressive = valid.find(t => t.format.protocol === 'progressive');
 if (progressive) return progressive;

 return valid.find(t => t.format.protocol === 'hls') ?? null;
}

// Nén danh sách phân đoạn fMP4 HLS thành gói JSON siêu gọn (< 1 KB kể cả với bản Nonstop 2 tiếng 750 phân đoạn).
export function parseM3u8ForWebAudio(m3u8Text, m3u8Url, mimeType = 'audio/mp4; codecs="mp4a.40.2"') {
 const cleanM3u8 = isAllowedWebAudioUrl(m3u8Url) ? safeStreamUrl(m3u8Url) : null;
 if (typeof m3u8Text !== 'string' || !m3u8Text.includes('#EXTM3U')) return null;

 const lines = m3u8Text
  .split(/\r?\n/)
  .map(l => l.trim())
  .filter(Boolean);

 let initUri = null;
 const segments = [];
 let pendingDur = 0;

 for (const line of lines) {
  if (line.startsWith('#EXT-X-MAP:')) {
   const match = line.match(/URI="([^"]+)"/i);
   if (match?.[1]) initUri = match[1];
   continue;
  }
  if (line.startsWith('#EXTINF:')) {
   const durStr = line.slice(8).split(',')[0];
   const parsed = Number.parseFloat(durStr);
   pendingDur = Number.isFinite(parsed) && parsed > 0 ? parsed : 10;
   continue;
  }
  if (!line.startsWith('#')) {
   const resolved = resolveRelativeUrl(line, cleanM3u8);
   if (resolved && isAllowedWebAudioUrl(resolved)) {
    segments.push({ url: resolved, duration: pendingDur || 10 });
   }
   pendingDur = 0;
  }
 }

 if (!segments.length) return null;

 const resolvedInit = initUri ? resolveRelativeUrl(initUri, cleanM3u8) : null;
 if (!resolvedInit || !isAllowedWebAudioUrl(resolvedInit)) {
  return cleanM3u8
   ? {
      kind: 'hls_m3u8',
      m3u8Url: cleanM3u8,
      mime: 'application/vnd.apple.mpegurl',
      fetchedAtMs: Date.now(),
     }
   : null;
 }

 const firstParts = splitDirFileQuery(segments[0].url);
 const initParts = splitDirFileQuery(resolvedInit);
 if (!firstParts || !initParts) return null;

 const nonLastDurs = segments.length > 1 ? segments.slice(0, -1).map(s => s.duration) : [segments[0].duration];
 const avgSegDur =
  nonLastDurs.reduce((sum, d) => sum + d, 0) / Math.max(1, nonLastDurs.length);
 const lastDur = segments[segments.length - 1].duration;

 const sameBaseAndAuth =
  initParts.baseUrl === firstParts.baseUrl &&
  initParts.auth === firstParts.auth &&
  segments.every(s => {
   const p = splitDirFileQuery(s.url);
   return p && p.baseUrl === firstParts.baseUrl && p.auth === firstParts.auth;
  });

 if (sameBaseAndAuth) {
  const seqMatch = firstParts.file.match(/^([a-zA-Z_-]*?)(\d+)(\.[a-zA-Z0-9]+)$/);
  if (seqMatch) {
   const [, prefix, firstDigits, ext] = seqMatch;
   const pad = firstDigits.length;
   const startIdx = Number.parseInt(firstDigits, 10);
   const isSequential =
    startIdx === 0 &&
    segments.every((s, idx) => {
     const p = splitDirFileQuery(s.url);
     const expected = `${prefix}${String(idx).padStart(pad, '0')}${ext}`;
     return p?.file === expected;
    });

   if (isSequential) {
    return {
     kind: 'hls_fmp4',
     mime: String(mimeType || 'audio/mp4; codecs="mp4a.40.2"'),
     m3u8Url: cleanM3u8,
     baseUrl: firstParts.baseUrl,
     auth: firstParts.auth,
     init: initParts.file,
     prefix,
     pad,
     ext,
     count: segments.length,
     segDur: Number(avgSegDur.toFixed(5)),
     lastDur: Number(lastDur.toFixed(3)),
     fetchedAtMs: Date.now(),
    };
   }
  }

  // Dự phòng nếu tên tệp phân đoạn không đánh số tuần tự nhưng vẫn chung thư mục & chữ ký
  if (segments.length <= 240) {
   return {
    kind: 'hls_fmp4',
    mime: String(mimeType || 'audio/mp4; codecs="mp4a.40.2"'),
    m3u8Url: cleanM3u8,
    baseUrl: firstParts.baseUrl,
    auth: firstParts.auth,
    init: initParts.file,
    files: segments.map(s => splitDirFileQuery(s.url).file),
    count: segments.length,
    segDur: Number(avgSegDur.toFixed(5)),
    lastDur: Number(lastDur.toFixed(3)),
    fetchedAtMs: Date.now(),
   };
  }
 }

 return cleanM3u8
  ? {
     kind: 'hls_m3u8',
     m3u8Url: cleanM3u8,
     mime: 'application/vnd.apple.mpegurl',
     fetchedAtMs: Date.now(),
    }
  : null;
}

function resolveRelativeUrl(raw, base) {
 try {
  return base ? new URL(raw, base).toString() : new URL(raw).toString();
 } catch {
  return null;
 }
}

function splitDirFileQuery(rawUrl) {
 try {
  const u = new URL(rawUrl);
  const slashIdx = u.pathname.lastIndexOf('/');
  if (slashIdx < 0) return null;
  const baseUrl = `${u.origin}${u.pathname.slice(0, slashIdx + 1)}`;
  const file = u.pathname.slice(slashIdx + 1);
  if (!file) return null;
  return { baseUrl, file, auth: u.search || '' };
 } catch {
  return null;
 }
}

// Làm sạch và kiểm duyệt cấu trúc webAudio trước khi xuất ra JSON công khai cho Website.
export function sanitizeWebAudioDescriptor(raw) {
 if (!raw || typeof raw !== 'object') return null;

 if (raw.kind === 'progressive') {
  if (!isAllowedWebAudioUrl(raw.url)) return null;
  return {
   kind: 'progressive',
   url: safeStreamUrl(raw.url),
   mime: String(raw.mime || 'audio/mpeg').slice(0, 64),
   fetchedAtMs: Number(raw.fetchedAtMs) || Date.now(),
  };
 }

 if (raw.kind === 'hls_m3u8') {
  if (!isAllowedWebAudioUrl(raw.m3u8Url)) return null;
  return {
   kind: 'hls_m3u8',
   m3u8Url: safeStreamUrl(raw.m3u8Url),
   mime: 'application/vnd.apple.mpegurl',
   fetchedAtMs: Number(raw.fetchedAtMs) || Date.now(),
  };
 }

 if (raw.kind === 'hls_fmp4') {
  if (!isAllowedWebAudioUrl(raw.baseUrl)) return null;
  const count = Number(raw.count);
  if (!Number.isInteger(count) || count <= 0 || count > 5000) return null;
  const auth = typeof raw.auth === 'string' && raw.auth.startsWith('?') ? raw.auth.slice(0, 1800) : '';
  const init = typeof raw.init === 'string' && /^[a-zA-Z0-9._-]+$/.test(raw.init) ? raw.init : null;
  if (!init) return null;

  const clean = {
   kind: 'hls_fmp4',
   mime: String(raw.mime || 'audio/mp4; codecs="mp4a.40.2"').slice(0, 80),
   m3u8Url: isAllowedWebAudioUrl(raw.m3u8Url) ? safeStreamUrl(raw.m3u8Url) : null,
   baseUrl: safeStreamUrl(raw.baseUrl),
   auth,
   init,
   count,
   segDur: Math.max(0.5, Math.min(60, Number(raw.segDur) || 10)),
   lastDur: Math.max(0.05, Math.min(60, Number(raw.lastDur) || 10)),
   fetchedAtMs: Number(raw.fetchedAtMs) || Date.now(),
  };

  if (Array.isArray(raw.files)) {
   const safeFiles = raw.files.filter(f => typeof f === 'string' && /^[a-zA-Z0-9._-]+$/.test(f));
   if (safeFiles.length !== count) return null;
   clean.files = safeFiles;
   return clean;
  }

  const prefix = typeof raw.prefix === 'string' && /^[a-zA-Z0-9_-]{0,24}$/.test(raw.prefix) ? raw.prefix : null;
  const ext = typeof raw.ext === 'string' && /^\.[a-zA-Z0-9]{1,8}$/.test(raw.ext) ? raw.ext : null;
  const pad = Number(raw.pad);
  if (prefix === null || !ext || !Number.isInteger(pad) || pad < 1 || pad > 8) return null;
  clean.prefix = prefix;
  clean.pad = pad;
  clean.ext = ext;
  return clean;
 }

 return null;
}

// Trích xuất luồng âm thanh trực tiếp từ SoundCloud để trình duyệt tự phát song song mà không tốn băng thông/RAM của bot.
export async function resolveTrackWebAudio(scClient, track, { fetchImpl = fetch, forceRefreshDetails = false } = {}) {
 if (!scClient || !track) return null;
 const trackUrl = safeStreamUrl(track.url, 1024);
 if (!trackUrl || !trackUrl.includes('soundcloud.com')) return null;

 try {
  let details = !forceRefreshDetails ? detailsCache.get(trackUrl) : null;
  if (!details) {
   details = await scClient.fetchItem(trackUrl);
   if (details?.media?.transcodings) {
    if (detailsCache.size >= MAX_DETAILS_CACHE) {
     const oldest = detailsCache.keys().next().value;
     if (oldest) detailsCache.delete(oldest);
    }
    detailsCache.set(trackUrl, details);
   }
  }

  const best = pickWebPlayableTranscoding(details?.media?.transcodings);
  if (!best?.url) return null;

  const streamUrl = await scClient.getStreamUrl(best.url);
  if (!streamUrl || !isAllowedWebAudioUrl(streamUrl)) return null;

  if (best.format?.protocol === 'progressive') {
   return sanitizeWebAudioDescriptor({
    kind: 'progressive',
    url: streamUrl,
    mime: best.format?.mime_type || 'audio/mpeg',
    fetchedAtMs: Date.now(),
   });
  }

  const res = await fetchImpl(streamUrl, { signal: AbortSignal.timeout(6000) });
  if (!res?.ok) return null;
  const m3u8Text = await res.text();
  const parsed = parseM3u8ForWebAudio(m3u8Text, streamUrl, best.format?.mime_type);
  return sanitizeWebAudioDescriptor(parsed);
 } catch {
  return null;
 }
}
