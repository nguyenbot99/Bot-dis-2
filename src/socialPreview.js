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

async function readJsonLimited(url, fetchImpl) {
 const res = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(12000), headers: { 'Accept': 'application/json' } });
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

export async function resolveSocialPreview(input, { fetchImpl = fetch } = {}) {
 const parsed = parseSocialUrl(input);
 const result = { ...parsed, title: `Bài đăng ${parsed.platform}`, author: '', media: null, source: null };
 try {
  if (parsed.platform === 'TikTok') {
   const endpoint = new URL('https://www.tikwm.com/api/');
   endpoint.searchParams.set('url', parsed.url);
   const data = (await readJsonLimited(endpoint, fetchImpl))?.data;
   if (!data || typeof data !== 'object') return result;
   result.title = String(data.title || result.title).slice(0, 240);
   result.author = String(data.author?.nickname || data.author?.unique_id || '').slice(0, 100);
   const image = Array.isArray(data.images) ? data.images.find(x => typeof x === 'string') : null;
   if (image) result.media = { url: image, type: 'image' };
   else if (typeof data.wmplay === 'string' && data.wmplay) result.media = { url: data.wmplay, type: 'video' };
   else if (typeof data.play === 'string' && data.play) result.media = { url: data.play, type: 'video' };
   result.source = 'TikWM';
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
  return ['tiktokcdn.com', 'tiktokcdn-us.com', 'tiktokcdn-eu.com', 'tikwm.com', 'twimg.com'].some(root => belongs(url.hostname.toLowerCase(), root));
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
