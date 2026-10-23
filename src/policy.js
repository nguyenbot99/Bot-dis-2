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
const SOUNDCLOUD_SHORT_HOSTS = new Set(['on.soundcloud.com', 'soundcloud.app.goo.gl']);
const TRACKING_PARAMS = new Set(['si', 'ref', 'in', 'fbclid', 'gclid', 'feature']);

// Chuẩn hóa đường dẫn YouTube / SoundCloud về định dạng chuẩn mà bộ giải mã nhạc xử lý ổn định nhất.
function normalizeMusicUrl(rawUrl) {
 let u;
 try { u = new URL(rawUrl); } catch { throw new Error('URL không hợp lệ.'); }
 const host = u.hostname.toLowerCase();
 const isAllowedHost = YOUTUBE_HOSTS.has(host) || SOUNDCLOUD_HOSTS.has(host) || SOUNDCLOUD_SHORT_HOSTS.has(host);
 if (u.protocol !== 'https:' || !isAllowedHost || u.username || u.password || u.port) {
  throw new Error('Chỉ nhận URL HTTPS từ YouTube hoặc SoundCloud.');
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
 } else if (SOUNDCLOUD_SHORT_HOSTS.has(host)) {
  u.pathname = u.pathname.replace(/\/+$/, '') || '/';
  if (u.pathname === '/') throw new Error('Link rút gọn SoundCloud không hợp lệ.');
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

 // Nếu người dùng bấm "Chia sẻ" từ app SoundCloud/YouTube trên điện thoại (có chữ kèm link https://...), tự tách link ra.
 if (!/^[a-z][a-z0-9+.-]*:/i.test(q)) {
  const embedded = q.match(/https:\/\/[^\s<>"]+/i)?.[0];
  if (embedded) {
   try {
    const h = new URL(embedded).hostname.toLowerCase();
    if (YOUTUBE_HOSTS.has(h) || SOUNDCLOUD_HOSTS.has(h) || SOUNDCLOUD_SHORT_HOSTS.has(h)) {
     q = embedded;
    }
   } catch {}
  }
 }

 if (/^[a-z][a-z0-9+.-]*:/i.test(q)) {
  return normalizeMusicUrl(q);
 }
 return q;
}

// Giải mã thêm các link rút gọn của SoundCloud (on.soundcloud.com / soundcloud.app.goo.gl) về link bài gốc an toàn.
export async function resolveMusicQuery(input, fetchImpl = fetch) {
 const q = validateQuery(input);
 if (!q.startsWith('https://')) return q;

 let current = new URL(q);
 for (let hop = 0; hop < 3 && SOUNDCLOUD_SHORT_HOSTS.has(current.hostname.toLowerCase()); hop++) {
  let res;
  try {
   res = await fetchImpl(current.toString(), {
    method: 'GET',
    redirect: 'manual',
    signal: AbortSignal.timeout(6000),
    headers: { 'User-Agent': 'Mozilla/5.0' },
   });
  } catch {
   throw new Error('Không thể kết nối để giải mã link rút gọn SoundCloud.');
  }

  const location = res.headers?.get?.('location');
  if (location) {
   res.body?.cancel?.().catch(() => {});
   const nextUrl = new URL(location, current).toString();
   current = new URL(validateQuery(nextUrl));
   continue;
  }

  // Dự phòng trường hợp trang rút gọn trả về HTML chứa đường dẫn đích thay vì mã chuyển hướng 302.
  const html = (await res.text?.().catch(() => ''))?.slice(0, 16384) ?? '';
  const match = html.match(/https:\/\/(?:www\.|m\.)?soundcloud\.com\/[A-Za-z0-9._~:/?#[\]@!$&'()*+,;=%-]+/i)?.[0];
  if (!match) throw new Error('Không thể giải mã link rút gọn SoundCloud này — hãy thử dán link bài hát đầy đủ.');
  current = new URL(validateQuery(match));
 }

 if (SOUNDCLOUD_SHORT_HOSTS.has(current.hostname.toLowerCase())) {
  throw new Error('Link rút gọn SoundCloud chuyển hướng quá nhiều lần.');
 }
 return validateQuery(current.toString());
}
