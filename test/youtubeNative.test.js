import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
 buildYouTubeCookieAuthHeaders,
 createNativeYouTubePlugin,
 findHlsSegmentStartIndex,
 mapRawFormatToSabr,
 parseYouTubeHlsMasterAudioUrl,
 parseYouTubeHlsMediaPlaylist,
 searchYouTubeVideos,
} from '../src/youtubeNative.js';

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

test('VISIONOS HLS parser selects itag/234 high-bitrate audio, seeks to exact #EXTINF segment, and streams via getStream', async () => {
 const masterM3u8 = [
  '#EXTM3U',
  '#EXT-X-MEDIA:URI="https://manifest.googlevideo.com/api/manifest/hls_playlist/itag/233/playlist/index.m3u8",TYPE=AUDIO,GROUP-ID="233",DEFAULT=YES',
  '#EXT-X-MEDIA:URI="https://manifest.googlevideo.com/api/manifest/hls_playlist/itag/234/playlist/index.m3u8",TYPE=AUDIO,GROUP-ID="234",DEFAULT=YES',
 ].join('\n');
 assert.equal(
  parseYouTubeHlsMasterAudioUrl(masterM3u8),
  'https://manifest.googlevideo.com/api/manifest/hls_playlist/itag/234/playlist/index.m3u8',
 );

 const mediaM3u8 = [
  '#EXTM3U',
  '#EXT-X-VERSION:3',
  '#EXTINF:5.0,',
  'https://rr1---sn-test.googlevideo.com/seg0.ts',
  '#EXTINF:5.0,',
  'https://rr1---sn-test.googlevideo.com/seg1.ts',
  '#EXTINF:5.0,',
  'https://rr1---sn-test.googlevideo.com/seg2.ts',
 ].join('\n');
 const parsed = parseYouTubeHlsMediaPlaylist(mediaM3u8);
 assert.equal(parsed.segments.length, 3);
 assert.equal(parsed.totalDurationMs, 15_000);
 assert.equal(findHlsSegmentStartIndex(parsed.segments, 0), 0);
 assert.equal(findHlsSegmentStartIndex(parsed.segments, 4999), 0);
 assert.equal(findHlsSegmentStartIndex(parsed.segments, 5000), 1);
 assert.equal(findHlsSegmentStartIndex(parsed.segments, 11_200), 2);

 const mockFetch = async url => {
  const u = String(url);
  if (u.includes('/youtubei/v1/player')) {
   return {
    ok: true,
    status: 200,
    json: async () => ({
     playabilityStatus: { status: 'OK' },
     videoDetails: { videoId: '7h9ST6bd-5w', lengthSeconds: '15', isLiveContent: false },
     streamingData: { hlsManifestUrl: 'https://manifest.googlevideo.com/master.m3u8' },
    }),
   };
  }
  if (u.endsWith('/master.m3u8')) {
   return { ok: true, status: 200, arrayBuffer: async () => Buffer.from(masterM3u8, 'utf8') };
  }
  if (u.endsWith('/index.m3u8')) {
   return { ok: true, status: 200, arrayBuffer: async () => Buffer.from(mediaM3u8, 'utf8') };
  }
  const segLabel = u.split('/').pop();
  return { ok: true, status: 200, arrayBuffer: async () => Buffer.from(`[${segLabel}]`, 'utf8') };
 };

 const synced = [];
 const plugin = createNativeYouTubePlugin({
  fetchImpl: mockFetch,
  onTrackMetaSynced: t => synced.push(t.duration),
 });
 const track = {
  id: '7h9ST6bd-5w',
  title: 'Hãy Cho Tôi',
  url: 'https://www.youtube.com/watch?v=7h9ST6bd-5w',
  duration: 0,
  source: 'youtube',
 };
 const streamInfo = await plugin.getStream(track);
 const chunks = [];
 for await (const c of streamInfo.stream) chunks.push(c.toString('utf8'));
 assert.equal(chunks.join(''), '[seg0.ts][seg1.ts][seg2.ts]');
 assert.deepEqual(synced, [15_000]);

 // Kiểm tra recreate(positionMs) nhảy thẳng tới phân đoạn #1 (5.0s)
 const seekedStream = await streamInfo.recreate(5200);
 const seekChunks = [];
 for await (const c of seekedStream) seekChunks.push(c.toString('utf8'));
 assert.equal(seekChunks.join(''), '[seg1.ts][seg2.ts]');
});

test('buildYouTubeCookieAuthHeaders parses both raw Cookie header and Netscape cookies.txt with SAPISIDHASH', () => {
 const raw = '"Cookie: SID=abc123; __Secure-3PAPISID=my_sapisid_val; PREF=hl=vi"';
 const h1 = buildYouTubeCookieAuthHeaders(raw, 'https://music.youtube.com', 1_760_000_000);
 assert.equal(h1.Cookie, 'SID=abc123; __Secure-3PAPISID=my_sapisid_val; PREF=hl=vi');
 assert.match(h1.Authorization, /^SAPISIDHASH 1760000000_[0-9a-f]{40}$/);
 assert.equal(h1['X-Origin'], 'https://music.youtube.com');
 assert.equal(h1['X-Goog-AuthUser'], '0');

 const netscape = [
  '# Netscape HTTP Cookie File',
  '#HttpOnly_.youtube.com\tTRUE\t/\tTRUE\t1893456000\tSID\tsid_token_99',
  '.youtube.com\tTRUE\t/\tTRUE\t1893456000\tSAPISID\tsapi_token_88',
  '.google.com\tTRUE\t/\tTRUE\t1893456000\tNID\tignore_other_domain',
 ].join('\n');
 const h2 = buildYouTubeCookieAuthHeaders(netscape, 'https://www.youtube.com', 1_760_000_000);
 assert.equal(h2.Cookie, 'SID=sid_token_99; SAPISID=sapi_token_88');
 assert.match(h2.Authorization, /^SAPISIDHASH 1760000000_[0-9a-f]{40}$/);
});

test('mapRawFormatToSabr preserves xtags and lastModified so SabrStream format keys match MediaHeader keys without infinite loop', async () => {
 const { buildSabrFormat } = await import('googlevideo/utils');
 const mapped = mapRawFormatToSabr(buildSabrFormat, {
  itag: 251,
  xtags: 'CgIIAXoCdmI',
  mimeType: 'audio/webm; codecs="opus"',
  bitrate: 148000,
  lastModified: '1729123456789012',
  contentLength: '3570821',
  approxDurationMs: '208030',
  audioQuality: 'AUDIO_QUALITY_MEDIUM',
  isDrc: true,
 });
 assert.equal(mapped.itag, 251);
 assert.equal(mapped.xtags, 'CgIIAXoCdmI');
 assert.equal(mapped.lastModified, '1729123456789012');
 assert.equal(mapped.contentLength, 3570821);
 assert.equal(mapped.approxDurationMs, 208030);
 assert.equal(mapped.isDrc, true);
});



