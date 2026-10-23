import spotifyUrlInfo from 'spotify-url-info';

const { getPreview: defaultSpotifyGetPreview } = spotifyUrlInfo(fetch);

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
 } else if (host === 'm.youtube.com') {
  u.hostname = 'www.youtube.com';
 } else if (host === 'www.youtu.be') {
  u.hostname = 'youtu.be';
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

// Giải mã link rút gọn (on.soundcloud.com / spotify.link) và chuyển link bài hát Spotify sang truy vấn phát nhạc.
export async function resolveMusicQuery(input, fetchImpl = fetch, spotifyPreviewFn = defaultSpotifyGetPreview) {
 const q = validateQuery(input);
 if (!q.startsWith('https://')) return q;

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
  const match = html.match(/https:\/\/(?:(?:www\.|m\.)?soundcloud\.com|open\.spotify\.com)\/[A-Za-z0-9._~:/?#[\]@!$&'()*+,;=%-]+/i)?.[0];
  if (!match) throw new Error('Không thể giải mã link rút gọn này — hãy thử dán link bài hát đầy đủ.');
  current = new URL(validateQuery(match));
 }

 if (SHORT_REDIRECT_HOSTS.has(current.hostname.toLowerCase())) {
  throw new Error('Link rút gọn chuyển hướng quá nhiều lần.');
 }

 const normalized = validateQuery(current.toString());
 if (SPOTIFY_HOSTS.has(new URL(normalized).hostname.toLowerCase())) {
  try {
   const meta = await spotifyPreviewFn(normalized);
   const combined = [meta?.title, meta?.artist].filter(Boolean).join(' - ').trim();
   if (!combined) throw new Error('Empty metadata');
   return combined.slice(0, 300);
  } catch {
   throw new Error('Không thể đọc thông tin bài hát từ link Spotify này.');
  }
 }
 return normalized;
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
