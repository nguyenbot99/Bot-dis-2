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
