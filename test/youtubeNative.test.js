import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNativeYouTubePlugin, searchYouTubeVideos } from '../src/youtubeNative.js';

test('createNativeYouTubePlugin validates only YouTube URLs/yt: queries and leaves plain keywords to SoundCloud', async () => {
 const plugin = createNativeYouTubePlugin();
 assert.equal(plugin.name, 'youtube');
 assert.equal(plugin.validate('https://www.youtube.com/watch?v=xypzmu5mMPY'), true);
 assert.equal(plugin.validate('https://youtu.be/FN7ALfpGxiI'), true);
 assert.equal(plugin.validate('https://www.youtube.com/playlist?list=PLHNNYen-Kcf6XW_30sNPqDtW04cHd8bM2'), true);
 assert.equal(plugin.validate('https://soundcloud.com/artist/song'), false);
 assert.equal(plugin.validate('nơi này có anh'), false);

 assert.equal(plugin.canHandle('yt: nơi này có anh'), true);
 assert.equal(plugin.canHandle('nơi này có anh'), false);

 // Từ khóa thường và link SoundCloud phải trả mảng rỗng ngay tức thì để không gọi trùng tìm kiếm.
 const plain = await plugin.search('nơi này có anh', 'u1');
 assert.deepEqual(plain, { tracks: [] });
 const sc = await plugin.search('https://soundcloud.com/artist/song', 'u1');
 assert.deepEqual(sc, { tracks: [] });

 // getRelatedTracks của YouTube không được can thiệp vào bài đang phát từ SoundCloud.
 const scRelated = await plugin.getRelatedTracks({
  id: '123',
  title: 'Test',
  url: 'https://soundcloud.com/artist/song',
  source: 'soundcloud',
 });
 assert.deepEqual(scRelated, []);
});

test('searchYouTubeVideos parses FieldMask JSON results cleanly and skips livestreams/deleted items', async () => {
 const mockFetch = async (url, init) => {
  assert.ok(String(url).includes('/youtubei/v1/search'));
  assert.ok(init?.headers?.['X-Goog-FieldMask']);
  const body = JSON.parse(init.body);
  assert.equal(body.query, 'Sơn Tùng M-TP');
  return {
   ok: true,
   json: async () => ({
    contents: {
     twoColumnSearchResultsRenderer: {
      primaryContents: {
       sectionListRenderer: {
        contents: [
         {
          itemSectionRenderer: {
           contents: [
            {
             videoRenderer: {
              videoId: 'live999',
              title: { runs: [{ text: '24/7 Live Radio' }] },
              // Không có lengthText -> livestream -> phải tự bỏ qua
             },
            },
            {
             videoRenderer: {
              videoId: 'abPmZCZZrFA',
              title: { runs: [{ text: 'SƠN TÙNG M-TP | ĐỪNG LÀM TRÁI TIM ANH ĐAU | OFFICIAL MUSIC VIDEO' }] },
              ownerText: { runs: [{ text: 'Sơn Tùng M-TP Official' }] },
              lengthText: { simpleText: '5:26' },
             },
            },
           ],
          },
         },
        ],
       },
      },
     },
    },
   }),
  };
 };

 const items = await searchYouTubeVideos('yt: Sơn Tùng M-TP', { fetchImpl: mockFetch });
 assert.equal(items.length, 1);
 assert.equal(items[0].videoId, 'abPmZCZZrFA');
 assert.equal(items[0].url, 'https://www.youtube.com/watch?v=abPmZCZZrFA');
 assert.equal(items[0].cleanTitle, 'ĐỪNG LÀM TRÁI TIM ANH ĐAU');
 assert.equal(items[0].artist, 'Sơn Tùng M-TP');
 assert.equal(items[0].durationMs, 326_000);
});
