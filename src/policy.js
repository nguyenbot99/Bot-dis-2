import spotifyUrlInfo from 'spotify-url-info';

const { getPreview: defaultSpotifyGetPreview, getDetails: defaultSpotifyGetDetails } = spotifyUrlInfo(fetch);

// Đọc và kiểm tra cấu hình môi trường; chỉ bắt buộc có Token, còn GUILD_ID là tùy chọn.
export function resolveConfig(env = process.env) {
 const rawToken = env.DISCORD_TOKEN || env.BOT_TOKEN || env.DISCORD_BOT_TOKEN || env.TOKEN || '';
 const token = String(rawToken).trim().replace(/^(['"])(.*)\1$/, '$2').trim();
 if (!token) throw new Error('Thiếu DISCORD_TOKEN trong biến môi trường.');

 const rawGuildId = String(env.GUILD_ID ?? '').trim();
 if (rawGuildId && !/^\d{17,20}$/.test(rawGuildId)) {
  throw new Error('GUILD_ID không hợp lệ (cần 17–20 chữ số, hoặc để trống).');
 }

 const autoRegister = !['false', '0'].includes(String(env.AUTO_REGISTER ?? 'true').trim().toLowerCase());
 return { token, guildId: rawGuildId || null, autoRegister };
}

const YOUTUBE_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be', 'www.youtu.be']);
const SOUNDCLOUD_HOSTS = new Set(['soundcloud.com', 'www.soundcloud.com', 'm.soundcloud.com']);
const SHORT_REDIRECT_HOSTS = new Set(['on.soundcloud.com', 'soundcloud.app.goo.gl', 'spotify.link', 'spotify.app.link']);
const SPOTIFY_HOSTS = new Set(['open.spotify.com']);
const TRACKING_PARAMS = new Set(['si', 'ref', 'in', 'fbclid', 'gclid', 'feature', 'nd', 'context']);

function isSupportedHost(host) {
 return YOUTUBE_HOSTS.has(host) || SOUNDCLOUD_HOSTS.has(host) || SHORT_REDIRECT_HOSTS.has(host) || SPOTIFY_HOSTS.has(host);
}

// Tách mã video 11 ký tự hợp lệ từ link YouTube / YouTube Music / Shorts / youtu.be.
export function extractYouTubeVideoId(rawUrl) {
 let u;
 try { u = new URL(rawUrl); } catch { return null; }
 const host = u.hostname.toLowerCase();
 if (!YOUTUBE_HOSTS.has(host)) return null;
 if (/^\/(?:live|channel|c|user|@)/i.test(u.pathname)) {
  throw new Error('Bản tiết kiệm RAM không nhận livestream hoặc trang kênh YouTube — hãy dán link bài hát cụ thể.');
 }
 let id = '';
 if (host === 'youtu.be' || host === 'www.youtu.be') {
  id = u.pathname.split('/').filter(Boolean)[0] ?? '';
 } else if (u.pathname === '/watch') {
  id = u.searchParams.get('v') ?? '';
 } else {
  const m = u.pathname.match(/^\/(?:shorts|embed|v)\/([A-Za-z0-9_-]{3,20})(?:\/|$)/);
  id = m?.[1] ?? '';
 }
 return /^[A-Za-z0-9_-]{3,20}$/.test(id) ? id : null;
}

// Chuẩn hóa đường dẫn YouTube / SoundCloud / Spotify về định dạng chuẩn mà bộ giải mã nhạc xử lý ổn định nhất.
function normalizeMusicUrl(rawUrl) {
 let u;
 try { u = new URL(rawUrl); } catch { throw new Error('URL không hợp lệ.'); }
 const host = u.hostname.toLowerCase();
 if (u.protocol !== 'https:' || !isSupportedHost(host) || u.username || u.password || u.port) {
  throw new Error('Chỉ nhận URL HTTPS từ YouTube, SoundCloud hoặc Spotify.');
 }
 if (u.searchParams.has('list') || /\/playlist|\/sets\//i.test(u.pathname)) {
  throw new Error('Bản tiết kiệm RAM không nhận danh sách phát (playlist/set) — hãy dán link bài lẻ.');
 }

 for (const key of [...u.searchParams.keys()]) {
  if (TRACKING_PARAMS.has(key.toLowerCase()) || key.toLowerCase().startsWith('utm_')) {
   u.searchParams.delete(key);
  }
 }
 u.hash = '';

 // SoundCloud API /resolve trả lỗi 404 nếu giữ tiền tố www./m. hoặc dấu "/" ở cuối đường dẫn.
 if (SOUNDCLOUD_HOSTS.has(host)) {
  u.hostname = 'soundcloud.com';
  u.pathname = u.pathname.replace(/\/+$/, '') || '/';
  const segments = u.pathname.split('/').filter(Boolean);
  if (segments.length < 2) {
   throw new Error('Hãy dán link của một bài hát SoundCloud cụ thể (không phải trang chủ hoặc trang cá nhân).');
  }
 } else if (SPOTIFY_HOSTS.has(host)) {
  u.pathname = u.pathname.replace(/^\/intl-[a-z]{2}\//i, '/').replace(/\/+$/, '') || '/';
  if (/^\/(playlist|album|artist|show|episode)\b/i.test(u.pathname)) {
   throw new Error('Bản tiết kiệm RAM không nhận danh sách phát/album Spotify — hãy dán link từng bài (/track/...).');
  }
  if (!/^\/track\/[A-Za-z0-9]+$/i.test(u.pathname)) {
   throw new Error('Link Spotify không hợp lệ (hãy dán link bài hát dạng open.spotify.com/track/...).');
  }
 } else if (SHORT_REDIRECT_HOSTS.has(host)) {
  u.pathname = u.pathname.replace(/\/+$/, '') || '/';
  if (u.pathname === '/') throw new Error('Link rút gọn không hợp lệ.');
 } else if (YOUTUBE_HOSTS.has(host)) {
  if (host === 'm.youtube.com') u.hostname = 'www.youtube.com';
  else if (host === 'www.youtu.be') u.hostname = 'youtu.be';
  const videoId = extractYouTubeVideoId(u.toString());
  if (!videoId) {
   throw new Error('Link YouTube không hợp lệ — hãy dán link một video bài hát cụ thể.');
  }
 }

 return u.toString();
}

// Kiểm tra từ khóa tìm kiếm hoặc đường dẫn nhạc hợp lệ (hỗ trợ cả chuỗi chia sẻ kèm chữ từ app điện thoại).
export function validateQuery(input) {
 let q = String(input ?? '').trim();
 if (!q || q.length > 400) throw new Error('Tên bài hoặc đường dẫn phải dài 1–400 ký tự.');

 // Nếu người dùng bấm "Chia sẻ" từ app điện thoại (có chữ kèm link https://...), tự tách link ra.
 if (!/^[a-z][a-z0-9+.-]*:/i.test(q)) {
  const embedded = q.match(/https:\/\/[^\s<>"]+/i)?.[0];
  if (embedded) {
   try {
    const h = new URL(embedded).hostname.toLowerCase();
    if (isSupportedHost(h)) q = embedded;
   } catch {}
  }
 }

 if (/^[a-z][a-z0-9+.-]*:/i.test(q)) {
  return normalizeMusicUrl(q);
 }
 return q;
}

function foldSearchText(str) {
 return String(str ?? '')
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .replace(/đ/gi, 'd')
  .toLowerCase();
}

function compactAlnum(str) {
 return foldSearchText(str).replace(/[^a-z0-9]+/g, '');
}

// Làm sạch tiêu đề & tên kênh từ YouTube oEmbed để tìm đúng bản nhạc gốc trên SoundCloud mà không bị nhiễu chữ "Official MV / 4K".
export function cleanYouTubeMetadata(rawTitle = '', rawAuthor = '') {
 const channelArtist = String(rawAuthor ?? '')
  .replace(/\s*(?:-\s*Topic|Official(?:\s+Channel|\s+Music)?|VEVO|Music|Channel)\s*$/gi, '')
  .replace(/✅/g, '')
  .trim();

 const noisePipeRe = /^(?:official\s*(?:music\s*)?(?:video|mv|audio|lyric\s*video|visualizer)|mv\s*official|audio\s*official|lyric\s*video|lyrics?|4k(?:\s*remaster(?:ed)?)?|hd|full\s*mv)$/i;
 const bracketNoiseRe = /\s*[\[(][^\]\)]*(?:official|music\s*video|\bmv\b|lyric|visualizer|audio|4k|hd|remaster|prod\.?|vietsub|sub|karaoke|tiktok)[^\]\)]*[\])]/gi;

 const pipeSegments = String(rawTitle ?? '')
  .replace(bracketNoiseRe, ' ')
  .split('|')
  .map(s => s.replace(/\s+/g, ' ').trim())
  .filter(s => s && !noisePipeRe.test(s));

 const authorCompact = compactAlnum(channelArtist);
 let artist = channelArtist;
 let coreTitle = pipeSegments.join(' - ');

 if (pipeSegments.length >= 2 && authorCompact.length >= 3) {
  const withoutAuthor = pipeSegments.filter(seg => {
   const c = compactAlnum(seg);
   return !(c && (c === authorCompact || c.includes(authorCompact) || authorCompact.includes(c)));
  });
  if (withoutAuthor.length && withoutAuthor.length < pipeSegments.length) {
   coreTitle = withoutAuthor.join(' - ');
  }
 }

 const dashParts = coreTitle.split(/\s+[-–—]\s+/).map(s => s.trim()).filter(Boolean);
 if (dashParts.length === 2 && authorCompact.length >= 3) {
  const [left, right] = dashParts;
  const leftC = compactAlnum(left);
  const rightC = compactAlnum(right);
  if (leftC && (leftC.includes(authorCompact) || authorCompact.includes(leftC))) {
   artist = left;
   coreTitle = right;
  } else if (rightC && (rightC.includes(authorCompact) || authorCompact.includes(rightC))) {
   artist = right;
   coreTitle = left;
  }
 }

 coreTitle = coreTitle
  .replace(/\b(?:official\s+(?:music\s+)?(?:video|mv|audio|lyric\s*video)|mv\s+official|4k\s+remaster(?:ed)?)\b/gi, ' ')
  .replace(/\s+/g, ' ')
  .replace(/^[-–—|:\s]+|[-–—|:\s]+$/g, '')
  .trim();

 return {
  title: coreTitle || String(rawTitle ?? '').trim(),
  artist,
 };
}

// Giải mã link rút gọn, link Spotify và link YouTube nhẹ qua HTTP/oEmbed (0 MB JSDOM, không bị chặn LOGIN_REQUIRED trên VPS).
export async function resolveMusicRequest(input, fetchImpl = fetch, spotifyResolverFn = null) {
 const q = validateQuery(input);
 if (!q.startsWith('https://')) return { query: q, spotifyMeta: null };

 let current = new URL(q);
 for (let hop = 0; hop < 3 && SHORT_REDIRECT_HOSTS.has(current.hostname.toLowerCase()); hop++) {
  let res;
  try {
   res = await fetchImpl(current.toString(), {
    method: 'GET',
    redirect: 'manual',
    signal: AbortSignal.timeout(6000),
    headers: { 'User-Agent': 'Mozilla/5.0' },
   });
  } catch {
   throw new Error('Không thể kết nối để giải mã link rút gọn.');
  }

  const location = res.headers?.get?.('location');
  if (location) {
   res.body?.cancel?.().catch(() => {});
   const nextUrl = new URL(location, current).toString();
   current = new URL(validateQuery(nextUrl));
   continue;
  }

  const html = (await res.text?.().catch(() => ''))?.slice(0, 16384) ?? '';
  const match = html.match(/https:\/\/(?:(?:www\.|m\.)?soundcloud\.com|open\.spotify\.com|(?:www\.|music\.)?youtube\.com|youtu\.be)\/[A-Za-z0-9._~:/?#[\]@!$&'()*+,;=%-]+/i)?.[0];
  if (!match) throw new Error('Không thể giải mã link rút gọn này — hãy thử dán link bài hát đầy đủ.');
  current = new URL(validateQuery(match));
 }

 if (SHORT_REDIRECT_HOSTS.has(current.hostname.toLowerCase())) {
  throw new Error('Link rút gọn chuyển hướng quá nhiều lần.');
 }

 const normalized = validateQuery(current.toString());
 const normHost = new URL(normalized).hostname.toLowerCase();

 if (SPOTIFY_HOSTS.has(normHost)) {
  try {
   if (spotifyResolverFn) {
    const meta = await spotifyResolverFn(normalized);
    const combined = [meta?.title, meta?.artist].filter(Boolean).join(' - ').trim();
    if (!combined) throw new Error('Empty metadata');
    return {
     query: combined.slice(0, 300),
     spotifyMeta: {
      title: meta?.title ?? '',
      artist: meta?.artist ?? '',
      durationMs: Number(meta?.durationMs ?? meta?.duration ?? 0) || 0,
      thumbnail: meta?.image ?? null,
     },
    };
   }
   const details = await defaultSpotifyGetDetails(normalized).catch(() => null);
   const preview = details?.preview ?? await defaultSpotifyGetPreview(normalized);
   const combined = [preview?.title, preview?.artist].filter(Boolean).join(' - ').trim();
   if (!combined) throw new Error('Empty metadata');
   return {
    query: combined.slice(0, 300),
    spotifyMeta: {
     title: preview?.title ?? '',
     artist: preview?.artist ?? '',
     durationMs: Number(details?.tracks?.[0]?.duration ?? 0) || 0,
     thumbnail: preview?.image ?? null,
    },
   };
  } catch {
   throw new Error('Không thể đọc thông tin bài hát từ link Spotify này.');
  }
 }

 if (YOUTUBE_HOSTS.has(normHost)) {
  const videoId = extractYouTubeVideoId(normalized);
  if (!videoId) throw new Error('Link YouTube không hợp lệ.');
  const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;
  let oembed;
  try {
   const res = await fetchImpl(`https://www.youtube.com/oembed?url=${encodeURIComponent(watchUrl)}&format=json`, {
    signal: AbortSignal.timeout(6000),
    headers: { 'User-Agent': 'Mozilla/5.0' },
   });
   if (!res?.ok) throw new Error(`HTTP ${res?.status}`);
   oembed = await res.json();
  } catch {
   throw new Error('Không thể đọc thông tin bài hát từ link YouTube này (video bị ẩn hoặc không tồn tại).');
  }
  const cleaned = cleanYouTubeMetadata(oembed?.title, oembed?.author_name);
  const combined = [cleaned.title, cleaned.artist].filter(Boolean).join(' ').trim();
  if (!combined) throw new Error('Không thể đọc tên bài hát từ link YouTube này.');
  return {
   query: combined.slice(0, 300),
   spotifyMeta: {
    title: cleaned.title,
    artist: cleaned.artist,
    durationMs: 0,
    thumbnail: oembed?.thumbnail_url || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
   },
  };
 }

 return { query: normalized, spotifyMeta: null };
}

export async function resolveMusicQuery(input, fetchImpl = fetch, spotifyPreviewFn = null) {
 const { query } = await resolveMusicRequest(input, fetchImpl, spotifyPreviewFn);
 return query;
}

const VARIANT_REGEX = /\b(?:slowed|reverb|nightcore|sped\s*up|8d|1\s*hour|1\s*gio|karaoke|instrumental|beat\s*chuan|piano\s*beat|mv\s*cut|remix|rmx|cover|mashup|bootleg|rework|flip|edit|demo|teaser|trailer)\b/i;

// Chọn bản nhạc khớp nhất theo tên, ca sĩ và độ dài gốc (tránh chọn nhầm bản cover/remix/slowed hoặc đoạn cắt ngắn khi người dùng không yêu cầu).
export function pickBestMatchingTrack(tracks = [], hint = {}) {
 const valid = (Array.isArray(tracks) ? tracks : []).filter(t => t && !t.isLive && !(t.duration > 10800000));
 if (!valid.length) return tracks?.[0] ?? null;

 const targetTitle = foldSearchText(hint?.title).trim();
 const targetArtist = foldSearchText(hint?.artist ?? hint?.author).trim();
 const targetDurationMs = Number(hint?.durationMs ?? 0);
 if (!targetTitle && !targetArtist && !(targetDurationMs > 0)) return valid[0];

 const refText = `${targetTitle} ${targetArtist}`.trim();
 const askedVariant = VARIANT_REGEX.test(refText);
 const titleTokens = targetTitle.split(/[^a-z0-9]+/).filter(w => w.length >= 2);
 const artistTokens = targetArtist.split(/[^a-z0-9]+/).filter(w => w.length >= 2);

 let best = valid[0];
 let bestScore = -Infinity;

 valid.slice(0, 15).forEach((cand, idx) => {
  let score = Math.max(0, 12 - idx); // Giữ ưu tiên nhẹ cho thứ hạng tìm kiếm gốc.
  const cTitle = foldSearchText(cand.title);
  const cAuthor = foldSearchText(cand.metadata?.author);
  const cCombined = `${cTitle} ${cAuthor}`;

  if (targetTitle && cTitle.includes(targetTitle)) score += 24;
  for (const w of titleTokens) {
   if (cTitle.includes(w)) score += 10;
   else if (cCombined.includes(w)) score += 5;
  }

  if (targetArtist && (cAuthor.includes(targetArtist) || cCombined.includes(targetArtist))) {
   score += 26;
  }
  for (const w of artistTokens) {
   if (cAuthor.includes(w)) score += 12;
   else if (cTitle.includes(w)) score += 8;
  }

  if (/\b(?:official\s+audio|ban\s+chuan)\b/i.test(cTitle) || /-\s*topic$/i.test(cAuthor)) {
   score += 12;
  }

  if (!askedVariant && VARIANT_REGEX.test(cCombined)) {
   score -= 55;
  } else if (askedVariant && VARIANT_REGEX.test(cCombined)) {
   score += 30;
  }

  const candDur = Number(cand.duration ?? 0);
  const cMs = candDur > 1000 ? candDur : candDur * 1000;
  if (cMs > 0 && cMs < 75_000 && (!targetDurationMs || targetDurationMs >= 90_000)) {
   score -= 45;
  }
  if (targetDurationMs > 0 && cMs > 0) {
   const diffSec = Math.abs(cMs - targetDurationMs) / 1000;
   if (diffSec <= 5) score += 65;
   else if (diffSec <= 15) score += 45;
   else if (diffSec <= 35) score += 15;
   else if (diffSec > 60) score -= Math.min(140, Math.round(diffSec));
  }

  if (score > bestScore) {
   bestScore = score;
   best = cand;
  }
 });

 return best;
}

// Chuyển đổi chuỗi thời gian tua nhạc (ví dụ "90", "1:30", "01:05:20") sang mili-giây hợp lệ.
export function parseSeekTime(rawInput) {
 const raw = String(rawInput ?? '').trim().replace(/s$/i, '');
 if (!raw) throw new Error('Hãy nhập mốc thời gian cần tua (ví dụ `1:30` hoặc `90`).');
 if (/^\d+$/.test(raw)) {
  const sec = Number(raw);
  if (sec < 0 || sec > 10800) throw new Error('Thời gian tua phải nằm trong khoảng 0 đến 180 phút.');
  return sec * 1000;
 }
 if (/^\d{1,2}:\d{1,2}(?::\d{1,2})?$/.test(raw)) {
  const parts = raw.split(':').map(Number);
  if (parts.slice(1).some(v => v >= 60)) throw new Error('Số phút/giây sau dấu `:` phải nhỏ hơn 60 (ví dụ `1:30`).');
  const totalSec = parts.reduce((acc, cur) => acc * 60 + cur, 0);
  if (totalSec > 10800) throw new Error('Thời gian tua không được vượt quá 180 phút.');
  return totalSec * 1000;
 }
 throw new Error('Định dạng thời gian không hợp lệ (hãy nhập số giây như `90` hoặc `phút:giây` như `1:30`).');
}
