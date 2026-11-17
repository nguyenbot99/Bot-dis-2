import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const MAX_JSON = 512 * 1024;
const MAX_MEDIA = 7 * 1024 * 1024;
const platformHosts = {
 'tiktok.com': 'TikTok', 'instagram.com': 'Instagram', 'facebook.com': 'Facebook',
 'fb.watch': 'Facebook', 'youtube.com': 'YouTube', 'youtu.be': 'YouTube',
 'twitter.com': 'X', 'x.com': 'X', 'reddit.com': 'Reddit', 'redd.it': 'Reddit',
};
const belongs = (host, root) => host === root || host.endsWith(`.${root}`);

export function parseSocialUrl(input) {
 let url;
 try { url = new URL(String(input).trim()); } catch { throw new Error('Hãy nhập link mạng xã hội hợp lệ.'); }
 if (url.protocol !== 'https:' || url.username || url.password || url.port) throw new Error('Chỉ nhận link HTTPS thông thường, không chứa tài khoản hoặc cổng tùy chỉnh.');
 const host = url.hostname.toLowerCase();
 const platform = Object.entries(platformHosts).find(([root]) => belongs(host, root))?.[1];
 if (!platform) throw new Error('Chỉ hỗ trợ link TikTok, Instagram, Facebook, YouTube, X/Twitter hoặc Reddit.');
 // Không chuyển các thông số theo dõi cho dịch vụ bên thứ ba; YouTube cần v/list và Facebook cần id/story.
 if (platform === 'TikTok' || platform === 'X' || platform === 'Instagram') url.search = '';
 url.hash = '';
 return { platform, url: url.toString() };
}

async function readJsonLimited(url, fetchImpl, timeoutMs = 12000) {
 const res = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(timeoutMs), headers: { 'Accept': 'application/json' } });
 if (!res.ok || !res.body) throw new Error('Dịch vụ xem trước không phản hồi.');
 let total = 0;
 const chunks = [];
 for await (const chunk of res.body) {
  total += chunk.length;
  if (total > MAX_JSON) throw new Error('Dữ liệu xem trước quá lớn.');
  chunks.push(Buffer.from(chunk));
 }
 return JSON.parse(Buffer.concat(chunks, total).toString('utf8'));
}

// Chỉ đọc metadata HTML từ dịch vụ đã chọn, giới hạn dung lượng và thời gian.
async function readOpenGraph(url, fetchImpl) {
 const res = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(12000), headers: { 'User-Agent': 'Discordbot/2.0', Accept: 'text/html' } });
 if (!res.ok || !res.body || !(res.headers.get('content-type') || '').toLowerCase().includes('text/html')) throw new Error('Không đọc được dữ liệu xem trước.');
 const chunks = []; let total = 0;
 for await (const part of res.body) {
  total += part.length;
  if (total > MAX_JSON) throw new Error('Dữ liệu xem trước quá lớn.');
  chunks.push(Buffer.from(part));
 }
 const html = Buffer.concat(chunks, total).toString('utf8');
 const decode = value => value.replace(/&(?:amp|quot|apos|lt|gt|#(?:x[0-9a-f]+|[0-9]+));/gi, entity => {
  const map = { '&amp;': '&', '&quot;': '"', '&apos;': "'", '&lt;': '<', '&gt;': '>' };
  if (map[entity.toLowerCase()]) return map[entity.toLowerCase()];
  const n = entity.slice(2, -1); const code = n[0]?.toLowerCase() === 'x' ? parseInt(n.slice(1), 16) : parseInt(n, 10);
  return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
 });
 const result = {};
 for (const tag of html.match(/<meta\s+[^>]{1,8192}>/gi) || []) {
  const attrs = {};
  for (const m of tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[m[1].toLowerCase()] = decode(m[2] ?? m[3] ?? '');
  const key = (attrs.property || attrs.name || '').toLowerCase();
  if (key.startsWith('og:') && attrs.content && !(key in result)) result[key] = attrs.content;
 }
 return result;
}

export function socialEmbedProxy(parsed) {
 const original = new URL(parsed.url);
 if (parsed.platform === 'Instagram') {
  const m = original.pathname.match(/^\/(?:[A-Za-z0-9._]+\/)?(p|reel|reels)\/([A-Za-z0-9_-]{2,40})\/?$/i);
  if (!m) return null;
  return `https://ig.mynameistito.com/${m[1].toLowerCase()}/${m[2]}/`;
 }
 if (parsed.platform === 'Facebook' && (original.hostname === 'facebook.com' || original.hostname.endsWith('.facebook.com'))) {
  // Chỉ chuyển đường dẫn bài đăng, không chuyển các tham số đăng nhập/theo dõi.
  if (!/^\/(?:reel\/\d+\/?|watch\/?|share\/(?:r|v|p)\/[A-Za-z0-9]+\/?|[A-Za-z0-9.]+\/(?:videos|posts)\/[A-Za-z0-9._-]+\/?)$/i.test(original.pathname)) return null;
  const url = new URL(`https://www.facecot.com${original.pathname}`);
  if (original.pathname.startsWith('/watch') && /^\d+$/.test(original.searchParams.get('v') || '')) url.searchParams.set('v', original.searchParams.get('v'));
  return url.toString();
 }
 return null;
}

export async function resolveSocialPreview(input, { fetchImpl = fetch } = {}) {
 const parsed = parseSocialUrl(input);
 const result = { ...parsed, title: `Bài đăng ${parsed.platform}`, author: '', media: null, source: null };
 try {
  if (parsed.platform === 'TikTok') {
   const endpoint = new URL('https://www.tikwm.com/api/');
   endpoint.searchParams.set('url', parsed.url);
   // TikWM có thể mất hơn 12 giây cho link rút gọn; đã defer tương tác Discord.
   const data = (await readJsonLimited(endpoint, fetchImpl, 28000))?.data;
   if (!data || typeof data !== 'object') return result;
   result.title = String(data.title || result.title).slice(0, 240);
   result.author = String(data.author?.nickname || data.author?.unique_id || '').slice(0, 100);
   result.handle = String(data.author?.unique_id || '').replace(/^@/, '').slice(0, 40);
   if (typeof data.author?.avatar === 'string' && allowedMediaUrl(data.author.avatar)) result.avatar = data.author.avatar;
   if (typeof data.cover === 'string' && allowedMediaUrl(data.cover)) result.cover = data.cover;
   const image = Array.isArray(data.images) ? data.images.find(x => typeof x === 'string' && allowedMediaUrl(x)) : null;
   // wmplay đôi lúc trỏ đến tiktokv.us (không nằm trong danh sách tải an toàn),
   // còn play là MP4 trên CDN TikTok. Ưu tiên play để gửi được tệp video.
   const video = [data.play, data.wmplay, data.hdplay].find(x => typeof x === 'string' && allowedMediaUrl(x));
   if (image) result.media = { url: image, type: 'image' };
   else if (video) result.media = { url: video, type: 'video' };
   result.source = 'TikWM';
  } else if (parsed.platform === 'Instagram' || parsed.platform === 'Facebook') {
   const proxy = socialEmbedProxy(parsed);
   if (!proxy) return result;
   result.embedUrl = proxy;
   result.source = parsed.platform === 'Instagram' ? 'fxinstagram' : 'Facecot';
   const og = await readOpenGraph(proxy, fetchImpl);
   result.title = String(og['og:title'] || og['og:description'] || result.title).slice(0, 240);
   const video = og['og:video:secure_url'] || og['og:video'];
   const image = og['og:image:secure_url'] || og['og:image'];
   if (video && allowedMediaUrl(video)) result.media = { url: video, type: 'video' };
   else if (image && allowedMediaUrl(image)) result.media = { url: image, type: 'image' };
   if (result.media?.type === 'image' && parsed.platform === 'Facebook' && /\/(?:reel|videos|watch)(?:\/|$)/i.test(new URL(parsed.url).pathname)) result.coverOnly = true;
  } else if (parsed.platform === 'X') {
   const match = new URL(parsed.url).pathname.match(/^\/(?:[A-Za-z0-9_]+|i\/web)\/status\/(\d{5,25})\/?$/);
   if (!match) return result;
   const data = (await readJsonLimited(`https://api.fxtwitter.com/2/status/${match[1]}`, fetchImpl))?.tweet;
   if (!data) return result;
   result.title = String(data.text || result.title).slice(0, 240);
   result.author = String(data.author?.name || '').slice(0, 100);
   const item = Array.isArray(data.media?.all) ? data.media.all.find(x => x?.type === 'video' || x?.type === 'photo') : null;
   if (item && typeof item.url === 'string') result.media = { url: item.url, type: item.type === 'photo' ? 'image' : 'video' };
   result.source = 'FxTwitter';
  }
 } catch {
  // Dịch vụ ngoài có thể hỏng hoặc bài riêng tư; vẫn giữ link gốc.
 }
 return result;
}

export function allowedMediaUrl(raw) {
 try {
  const url = new URL(raw);
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return false;
  return ['tiktokcdn.com', 'tiktokcdn-us.com', 'tiktokcdn-eu.com', 'tikwm.com', 'twimg.com', 'cdninstagram.com', 'fbcdn.net', 'facecot.com'].some(root => belongs(url.hostname.toLowerCase(), root));
 } catch { return false; }
}

// Chỉ tải một tệp, giới hạn 7 MiB và ghi thẳng xuống ổ tạm; không đi theo redirect.
export async function downloadPreviewMedia(media, { fetchImpl = fetch, maxBytes = MAX_MEDIA } = {}) {
 if (!media || !allowedMediaUrl(media.url)) return null;
 const max = Math.max(0, Math.min(MAX_MEDIA, Number(maxBytes) || MAX_MEDIA));
 const res = await fetchImpl(media.url, { redirect: 'error', signal: AbortSignal.timeout(20000) });
 if (!res.ok || !res.body) throw new Error('Không tải được tệp đính kèm.');
 const type = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
 const ext = ({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'video/mp4': 'mp4' })[type];
 if (!ext || (media.type === 'image' && !type.startsWith('image/')) || (media.type === 'video' && type !== 'video/mp4')) {
  await res.body.cancel().catch(() => {});
  throw new Error('Định dạng tệp không được hỗ trợ.');
 }
 const size = Number(res.headers.get('content-length'));
 if (size > max) { await res.body.cancel().catch(() => {}); throw new Error('Tệp vượt giới hạn dung lượng.'); }
 const dir = await mkdtemp(path.join(os.tmpdir(), 'bot-preview-'));
 const file = path.join(dir, `bai-dang.${ext}`);
 let total = 0;
 const limiter = new Transform({ transform(chunk, enc, cb) {
  total += chunk.length;
  cb(total > max ? new Error('Tệp vượt giới hạn dung lượng.') : null, chunk);
 } });
 try {
  await pipeline(Readable.fromWeb(res.body), limiter, createWriteStream(file, { flags: 'wx', highWaterMark: 64 * 1024 }));
  return { file, cleanup: () => rm(dir, { recursive: true, force: true }) };
 } catch (error) {
  await rm(dir, { recursive: true, force: true }).catch(() => {});
  throw error;
 }
}

// Discord không hỗ trợ video đính kèm nằm bên trong Embed; ảnh bìa nằm trong thẻ,
// còn tệp MP4 thật được Discord hiển thị bằng trình phát riêng.
export function buildSocialPreviewPayload(result, { mediaFile = null, coverFile = null, note = '' } = {}) {
 const isVideo = result.media?.type === 'video' && !!mediaFile;
 const imageFile = isVideo ? coverFile : (result.media?.type === 'image' ? mediaFile : null);
 const files = [];
 if (mediaFile) files.push(mediaFile);
 const coverName = coverFile ? `anh-bia${path.extname(coverFile)}` : null;
 if (isVideo && coverFile) files.push({ attachment: coverFile, name: coverName });
 const author = [result.author, result.handle && !result.author?.includes(result.handle) ? `(@${result.handle})` : null].filter(Boolean).join(' ');
 const description = [result.title !== `Bài đăng ${result.platform}` ? result.title : null, note].filter(Boolean).join('\n\n').slice(0, 1200);
 const embed = {
  color: result.platform === 'TikTok' ? 0x25f4ee : 0x34d399,
  title: `${isVideo ? '🎬' : result.media?.type === 'image' ? '🖼️' : '🔗'} ${result.platform}`,
  url: result.url,
  description: description || 'Bài đăng công khai',
  ...(author ? { author: { name: author.slice(0, 250), ...(result.avatar && allowedMediaUrl(result.avatar) ? { icon_url: result.avatar } : {}) } } : {}),
  ...(imageFile ? { image: { url: `attachment://${isVideo ? coverName : path.basename(imageFile)}` } } : {}),
  footer: { text: `${isVideo ? 'Video được đính kèm phía trên' : result.coverOnly ? 'Chỉ có ảnh bìa, không có video gốc' : 'Xem bài gốc qua tiêu đề'}${result.source ? ` • Nguồn: ${result.source}` : ''}`.slice(0, 200) },
 };
 return {
  // Không gửi link trần khi đã có tệp: tránh Discord tự sinh thêm khung xem trước.
  content: !mediaFile ? `🔗 <${result.url}>${result.embedUrl ? `\n🌐 <${result.embedUrl}>` : ''}` : '',
  embeds: [embed],
  allowedMentions: { parse: [] },
  ...(files.length ? { files } : {}),
 };
}
