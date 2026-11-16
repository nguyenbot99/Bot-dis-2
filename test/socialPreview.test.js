import test from 'node:test';
import assert from 'node:assert/strict';
import { stat } from 'node:fs/promises';
import { parseSocialUrl, resolveSocialPreview, downloadPreviewMedia, allowedMediaUrl } from '../src/socialPreview.js';

test('Chỉ chấp nhận link HTTPS thuộc nền tảng hỗ trợ', () => {
 assert.equal(parseSocialUrl('https://vt.tiktok.com/ZS123/?tracking=abc').url, 'https://vt.tiktok.com/ZS123/');
 assert.equal(parseSocialUrl('https://www.facebook.com/watch/?v=123').platform, 'Facebook');
 for (const link of ['http://tiktok.com/a', 'https://tiktok.com.evil.test/a', 'https://user:pass@tiktok.com/a', 'https://tiktok.com:444/a', 'https://127.0.0.1/a']) assert.throws(() => parseSocialUrl(link));
 assert.equal(allowedMediaUrl('https://twimg.com.evil.test/a'), false);
 assert.equal(allowedMediaUrl('http://twimg.com/a'), false);
});

test('TikTok: xử lý dữ liệu, ưu tiên ảnh và loại thông số theo dõi', async () => {
 let requested;
 const fetchImpl = async url => {
  requested = String(url);
  return new Response(JSON.stringify({ data: { title: 'Ảnh đẹp', author: { nickname: 'A' }, images: ['https://p16.tiktokcdn.com/image.jpg'] } }), { status: 200 });
 };
 const data = await resolveSocialPreview('https://vt.tiktok.com/abc/?secret=hello', { fetchImpl });
 assert.equal(data.source, 'TikWM');
 assert.equal(data.media.type, 'image');
 assert.equal(new URL(requested).searchParams.get('url'), 'https://vt.tiktok.com/abc/');
});

test('X: dùng API cố định và nhận một ảnh', async () => {
 const fetchImpl = async url => {
  assert.equal(url, 'https://api.fxtwitter.com/2/status/123456');
  return new Response(JSON.stringify({ tweet: { text: 'Chào', media: { all: [{ type: 'photo', url: 'https://pbs.twimg.com/media/a.jpg' }] } } }));
 };
 const data = await resolveSocialPreview('https://x.com/user/status/123456', { fetchImpl });
 assert.equal(data.media.type, 'image');
 assert.equal(data.source, 'FxTwitter');
});

test('Facebook giữ link gốc khi không có nguồn tải trực tiếp', async () => {
 const result = await resolveSocialPreview('https://www.facebook.com/watch/?v=123', { fetchImpl: () => { throw new Error('không gọi mạng'); } });
 assert.equal(result.platform, 'Facebook');
 assert.equal(result.media, null);
});

test('Ghi tệp giới hạn xuống ổ tạm và xóa sau khi dùng', async () => {
 const fetchImpl = async () => new Response(Buffer.from('fake-image'), { headers: { 'content-type': 'image/jpeg' } });
 const media = { type: 'image', url: 'https://pbs.twimg.com/media/a.jpg' };
 const result = await downloadPreviewMedia(media, { fetchImpl, maxBytes: 100 });
 assert.equal((await stat(result.file)).size, 10);
 await result.cleanup();
 await assert.rejects(stat(result.file));
 await assert.rejects(downloadPreviewMedia(media, { fetchImpl, maxBytes: 5 }), /giới hạn/);
});

test('Instagram lấy ảnh từ metadata an toàn và giải mã dấu &', async () => {
 const fetchImpl = async url => {
  assert.equal(url, 'https://ig.mynameistito.com/p/ABC/');
  return new Response('<meta property="og:title" content="Ảnh &amp; hoa"><meta property="og:image" content="https://scontent.cdninstagram.com/photo.jpg?a=1&amp;b=2">', { headers: { 'content-type': 'text/html' } });
 };
 const data = await resolveSocialPreview('https://www.instagram.com/p/ABC/?utm=track', { fetchImpl });
 assert.equal(data.title, 'Ảnh & hoa');
 assert.equal(data.media.url, 'https://scontent.cdninstagram.com/photo.jpg?a=1&b=2');
});

test('Facebook chọn video công khai, chỉ gửi tham số v và chặn địa chỉ media lạ', async () => {
 let request;
 const fetchImpl = async url => {
  request = url;
  return new Response('<meta property="og:video" content="https://www.facecot.com/media/abc"><meta property="og:image" content="https://evil.test/a">', { headers: { 'content-type': 'text/html' } });
 };
 const result = await resolveSocialPreview('https://www.facebook.com/watch/?v=123&secret=abc', { fetchImpl });
 assert.equal(request, 'https://www.facecot.com/watch/?v=123');
 assert.equal(result.media.type, 'video');
 assert.equal(result.media.url, 'https://www.facecot.com/media/abc');
 assert.equal(allowedMediaUrl('https://facecot.com.evil.test/media'), false);
});

test('Facebook cho biết ảnh bìa khi video không có sẵn', async () => {
 const fetchImpl = async () => new Response('<meta property="og:image" content="https://www.facecot.com/media/abc">', { headers: { 'content-type': 'text/html' } });
 const result = await resolveSocialPreview('https://www.facebook.com/reel/123', { fetchImpl });
 assert.equal(result.coverOnly, true);
});
