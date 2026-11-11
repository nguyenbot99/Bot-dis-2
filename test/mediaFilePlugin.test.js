import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import ffmpegPath from 'ffmpeg-static';
import { StreamType } from '@discordjs/voice';

import {
 assertAndProbeRemoteMediaUrl,
 classifyMediaFileType,
 createMediaFilePlugin,
 isDirectMediaFileUrl,
 isPrivateOrReservedIp,
 MAX_MEDIA_FILE_BYTES,
 prettifyMediaFilename,
 refreshDiscordAttachmentUrlIfNeeded,
 resolvePlayFileTrack,
} from '../src/mediaFilePlugin.js';
import { resolveTrackWebAudio } from '../src/webAudio.js';
import { serializeNowPlayingState } from '../src/nowPlayingHub.js';
import { buildPlayerPayload } from '../src/playerGui.js';
import { commands } from '../src/commands.js';
import { assertMusicAccess } from '../src/access.js';
import workerModule from '../cloudflare-worker/worker.js';

test('SSRF shield blocks loopback, RFC1918, cloud metadata, IPv6 mapped ::ffff:, and 302 redirect bypasses', async () => {
 assert.equal(isPrivateOrReservedIp('127.0.0.1'), true);
 assert.equal(isPrivateOrReservedIp('10.0.0.5'), true);
 assert.equal(isPrivateOrReservedIp('172.20.1.2'), true);
 assert.equal(isPrivateOrReservedIp('192.168.1.10'), true);
 assert.equal(isPrivateOrReservedIp('169.254.169.254'), true);
 assert.equal(isPrivateOrReservedIp('::1'), true);
 assert.equal(isPrivateOrReservedIp('::ffff:127.0.0.1'), true);
 assert.equal(isPrivateOrReservedIp('::ffff:7f00:1'), true);
 assert.equal(isPrivateOrReservedIp('fe80::1'), true);
 assert.equal(isPrivateOrReservedIp('162.159.130.233'), false);

 const fakeDns = async host => {
  if (host === 'cdn.safe.example') return [{ address: '93.184.216.34', family: 4 }];
  return [{ address: '127.0.0.1', family: 4 }];
 };

 const redirectToInternalFetch = async () =>
  new Response(null, {
   status: 302,
   headers: { location: 'http://169.254.169.254/latest/meta-data/iam.mp3' },
  });

 await assert.rejects(
  () =>
   assertAndProbeRemoteMediaUrl('https://cdn.safe.example/song.mp3', {
    dnsLookup: fakeDns,
    fetchImpl: redirectToInternalFetch,
   }),
  /IP nội bộ bị chặn/,
 );

 await assert.rejects(
  () =>
   assertAndProbeRemoteMediaUrl('https://www.youtube.com/watch?v=xypzmu5mMPY', {
    dnsLookup: fakeDns,
   }),
  /dùng lệnh `\/play`/,
 );

 const oversizedFetch = async () =>
  new Response(null, {
   status: 206,
   headers: {
    'content-type': 'audio/mpeg',
    'content-range': `bytes 0-0/${MAX_MEDIA_FILE_BYTES + 1024}`,
   },
  });

 await assert.rejects(
  () =>
   assertAndProbeRemoteMediaUrl('https://cdn.safe.example/huge.mp3', {
    dnsLookup: fakeDns,
    fetchImpl: oversizedFetch,
   }),
  /250 MB/,
 );
});

test('filename prettifier, media classifier, and Discord CDN expired URL auto-refresh work cleanly', async () => {
 assert.equal(
  prettifyMediaFilename('Sơn_Tùng_M-TP_-_Nơi_Này_Có_Anh_Official_MV.mp4'),
  'Sơn Tùng M-TP - Nơi Này Có Anh Official MV',
 );
 assert.equal(classifyMediaFileType('.mp4', 'video/mp4').supported, true);
 assert.equal(classifyMediaFileType('.mp4', 'video/mp4').isVideo, true);
 assert.equal(classifyMediaFileType('.flac', 'audio/flac').supported, true);
 assert.equal(classifyMediaFileType('.flac', 'audio/flac').isVideo, false);
 assert.equal(classifyMediaFileType('.png', 'image/png').supported, false);
 assert.equal(classifyMediaFileType('.m3u8', 'application/vnd.apple.mpegurl').supported, false);
 assert.equal(
  isDirectMediaFileUrl('https://cdn.discordapp.com/attachments/111/222/clip_nhac.mp4?ex=67300000'),
  true,
 );
 assert.equal(isDirectMediaFileUrl('https://www.youtube.com/watch?v=abc'), false);

 let refreshCalled = 0;
 const fakeRest = {
  async post(route, payload) {
   refreshCalled++;
   assert.equal(route, '/attachments/refresh-urls');
   return {
    refreshed_urls: [
     {
      original: payload.body.attachment_urls[0],
      refreshed: 'https://cdn.discordapp.com/attachments/111/222/clip.mp3?ex=99999999&hm=fresh',
     },
    ],
   };
  },
 };

 const expiredUrl = 'https://cdn.discordapp.com/attachments/111/222/clip.mp3?ex=60000000&hm=old';
 const refreshed = await refreshDiscordAttachmentUrlIfNeeded(expiredUrl, fakeRest, 1_800_000_000_000);
 assert.equal(refreshCalled, 1);
 assert.match(refreshed, /hm=fresh/);

 // Chữ ký còn hạn xa (> 20 phút) sẽ không tốn lượt gọi API Discord
 const farFutureHex = Math.floor((1_800_000_000_000 + 5 * 3600_000) / 1000).toString(16);
 const freshUrl = `https://cdn.discordapp.com/attachments/111/222/clip.mp3?ex=${farFutureHex}&hm=stillgood`;
 const untouched = await refreshDiscordAttachmentUrlIfNeeded(freshUrl, fakeRest, 1_800_000_000_000);
 assert.equal(untouched, freshUrl);
 assert.equal(refreshCalled, 1);
});

test('real FFmpeg end-to-end streaming extracts 48kHz stereo PCM from both .mp3 audio and .mp4 video (-vn), supports recreate(seekMs), and rejects silent video', async () => {
 const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'botdis2-mediafile-'));
 const mp3Path = path.join(tmpDir, 'test_song.mp3');
 const mp4Path = path.join(tmpDir, 'test_mv.mp4');
 const silentMp4Path = path.join(tmpDir, 'silent_only.mp4');

 try {
  // Tạo tệp .mp3 thật dài 2.4 giây
  const genMp3 = spawnSync(ffmpegPath, [
   '-y',
   '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2.4',
   '-c:a', 'libmp3lame', '-b:a', '128k',
   mp3Path,
  ]);
  assert.equal(genMp3.status, 0);

  // Tạo tệp video .mp4 thật có cả hình màu + tiếng nhạc AAC dài 2.6 giây
  const genMp4 = spawnSync(ffmpegPath, [
   '-y',
   '-f', 'lavfi', '-i', 'color=c=purple:s=160x120:d=2.6',
   '-f', 'lavfi', '-i', 'sine=frequency=523.25:duration=2.6',
   '-c:v', 'mpeg4', '-c:a', 'aac', '-b:a', '128k',
   mp4Path,
  ]);
  assert.equal(genMp4.status, 0);

  // Tạo tệp video .mp4 câm hoàn toàn (không có rãnh âm thanh)
  const genSilent = spawnSync(ffmpegPath, [
   '-y',
   '-f', 'lavfi', '-i', 'color=c=black:s=160x120:d=1.2',
   '-c:v', 'mpeg4', '-an',
   silentMp4Path,
  ]);
  assert.equal(genSilent.status, 0);

  const filesByRoute = {
   '/nhac_chill.mp3': { filePath: mp3Path, mime: 'audio/mpeg' },
   '/video_ca_nhac.mp4': { filePath: mp4Path, mime: 'video/mp4' },
   '/video_cam.mp4': { filePath: silentMp4Path, mime: 'video/mp4' },
  };

  const server = http.createServer(async (req, res) => {
   const routePath = new URL(req.url, 'http://localhost').pathname;
   const entry = filesByRoute[routePath];
   if (!entry) {
    res.writeHead(404).end();
    return;
   }
   const buf = await fs.readFile(entry.filePath);
   const range = req.headers.range;
   if (range) {
    const m = range.match(/bytes=(\d+)-(\d*)/);
    const start = m ? Number(m[1]) : 0;
    const end = m && m[2] ? Math.min(Number(m[2]), buf.length - 1) : buf.length - 1;
    const slice = buf.subarray(start, end + 1);
    res.writeHead(206, {
     'Content-Type': entry.mime,
     'Accept-Ranges': 'bytes',
     'Content-Range': `bytes ${start}-${end}/${buf.length}`,
     'Content-Length': String(slice.length),
    });
    res.end(slice);
    return;
   }
   res.writeHead(200, {
    'Content-Type': entry.mime,
    'Accept-Ranges': 'bytes',
    'Content-Length': String(buf.length),
   });
   res.end(buf);
  });

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  // Ánh xạ tên miền kiểm thử an toàn sang máy chủ cục bộ để kiểm thử luồng HTTP thật
  const testDns = async () => [{ address: '93.184.216.34', family: 4 }];
  const rewriteFetch = (input, init) => {
   const u = new URL(String(input));
   u.hostname = '127.0.0.1';
   u.port = String(port);
   u.protocol = 'http:';
   return fetch(u.toString(), init);
  };

  try {
   const plugin = createMediaFilePlugin({
    ffmpegPath,
    dnsLookup: testDns,
    fetchImpl: rewriteFetch,
   });

   // 1) Kiểm thử tệp .mp3
   const mp3Track = await resolvePlayFileTrack(
    {
     rawUrl: 'https://files.example.org/nhac_chill.mp3',
     requestedBy: 'user_a',
     uploaderName: 'Nguyễn A',
    },
    { ffmpegPath, dnsLookup: testDns, fetchImpl: rewriteFetch },
   );
   assert.equal(mp3Track.source, 'file');
   assert.equal(mp3Track.title, 'nhac chill');
   assert.equal(mp3Track.metadata.isVideoFile, false);
   assert.ok(mp3Track.duration >= 2000 && mp3Track.duration <= 3000);

   const mp3StreamInfo = await plugin.getStream(mp3Track);
   assert.equal(mp3StreamInfo.inputType, StreamType.Raw);
   assert.equal(mp3StreamInfo.stream.inputType, StreamType.Raw);
   let mp3PcmBytes = 0;
   for await (const chunk of mp3StreamInfo.stream) {
    mp3PcmBytes += chunk.length;
   }
   // 2.4s * 48000 Hz * 2 kênh * 2 byte = ~460,800 byte PCM
   assert.ok(mp3PcmBytes > 350_000, `expected >350 KB PCM from mp3, got ${mp3PcmBytes}`);

   // 2) Kiểm thử tệp video .mp4 (tự tách tiếng -vn) + tua /seek qua recreate(1200)
   const mp4Track = await resolvePlayFileTrack(
    {
     rawUrl: 'https://files.example.org/video_ca_nhac.mp4',
     customTitle: 'MV Ca Nhạc Kỷ Niệm',
     requestedBy: 'user_b',
    },
    { ffmpegPath, dnsLookup: testDns, fetchImpl: rewriteFetch },
   );
   assert.equal(mp4Track.source, 'file');
   assert.equal(mp4Track.title, 'MV Ca Nhạc Kỷ Niệm');
   assert.equal(mp4Track.metadata.isVideoFile, true);

   const mp4StreamInfo = await plugin.getStream(mp4Track);
   let fullVideoAudioBytes = 0;
   for await (const chunk of mp4StreamInfo.stream) {
    fullVideoAudioBytes += chunk.length;
   }
   assert.ok(fullVideoAudioBytes > 380_000);

   // Tua tới giây 1.2s -> lượng PCM còn lại khoảng ~1.4s (< fullVideoAudioBytes)
   const seekedStream = await mp4StreamInfo.recreate(1200);
   assert.equal(seekedStream.inputType, StreamType.Raw);
   let seekedBytes = 0;
   for await (const chunk of seekedStream) {
    seekedBytes += chunk.length;
   }
   assert.ok(seekedBytes > 150_000 && seekedBytes < fullVideoAudioBytes - 100_000);

   // 3) Video không có tiếng phải báo lỗi tiếng Việt rõ ràng, không treo bot
   const silentTrack = await resolvePlayFileTrack(
    {
     rawUrl: 'https://files.example.org/video_cam.mp4',
     requestedBy: 'user_c',
    },
    { ffmpegPath, dnsLookup: testDns, fetchImpl: rewriteFetch },
   );
   await assert.rejects(() => plugin.getStream(silentTrack), /rãnh tiếng|âm thanh/);
  } finally {
   await new Promise(resolve => server.close(resolve));
  }
 } finally {
  await fs.rm(tmpDir, { recursive: true, force: true });
 }
});

test('/playfile registers cleanly, syncs Discord CDN files to Website Live Radio & Worker, and enforces requester/Owner rules', async () => {
 const playfileCmd = commands.find(c => c.name === 'playfile');
 assert.ok(playfileCmd, 'expected /playfile slash command to be registered');
 const optNames = (playfileCmd.options ?? []).map(o => o.name);
 assert.deepEqual(optNames, ['file', 'url', 'title', 'next']);

 // Quyền truy cập: phòng rảnh mở cho mọi người gọi /playfile; bài đang hát vẫn khóa quyền điều khiển về người mở bài + Chủ Bot
 const idlePlayer = { queue: { currentTrack: null }, userdata: { ownerId: 'alice', idleOpen: true } };
 assert.doesNotThrow(() => assertMusicAccess('playfile', 'bob', idlePlayer));

 const activeFilePlayer = {
  guildId: 'g1',
  isPlaying: true,
  isPaused: false,
  volume: 100,
  queue: {
   currentTrack: {
    id: 'file-demo123',
    title: 'Bản thu Guitar Acoustic',
    url: 'https://cdn.discordapp.com/attachments/1001/2002/guitar_demo.mp4?ex=9f000000&is=9ef00000&hm=abcd1234',
    duration: 185_000,
    requestedBy: 'bob',
    source: 'file',
    metadata: {
     author: 'Bob • Video tách tiếng',
     isVideoFile: true,
     mimeType: 'video/mp4',
    },
   },
   tracks: [],
  },
  userdata: { ownerId: 'alice', soundLabel: 'Rõ nét HD' },
 };

 assert.doesNotThrow(() => assertMusicAccess('skip', 'bob', activeFilePlayer));
 assert.doesNotThrow(() => assertMusicAccess('skip', '1243061570247069696', activeFilePlayer));
 assert.throws(() => assertMusicAccess('skip', 'alice', activeFilePlayer), /Bạn không có quyền/);

 // Đồng bộ luồng âm thanh trực tiếp lên Website Live Radio & Cloudflare Worker
 const webAudio = await resolveTrackWebAudio(null, activeFilePlayer.queue.currentTrack);
 assert.ok(webAudio);
 assert.equal(webAudio.kind, 'progressive');
 assert.equal(webAudio.mime, 'video/mp4');
 assert.match(webAudio.url, /^https:\/\/cdn\.discordapp\.com\/attachments\//);

 const state = serializeNowPlayingState({
  player: activeFilePlayer,
  overrides: {
   track: activeFilePlayer.queue.currentTrack,
   webAudio,
  },
 });
 assert.equal(state.track.source, 'file');
 assert.equal(state.track.sourceLabel, 'Tệp nhạc / Video');
 assert.equal(state.track.webAudio.kind, 'progressive');

 // Kiểm tra khung trình phát Discord Components V2 hiển thị đúng nhãn "Tệp nhạc / Video"
 const guiPayload = buildPlayerPayload(activeFilePlayer);
 assert.ok(JSON.stringify(guiPayload).includes('Tệp nhạc / Video'));

 // Kiểm tra Cloudflare Worker giữ nguyên webAudio của tệp đính kèm Discord cho trình duyệt phát trực tiếp
 const env = { NOW_PLAYING_PUSH_SECRET: 'test-secret-token' };
 const pushReq = new Request('https://bot-dis-2.botmusicvip.workers.dev/api/now-playing', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-secret-token' },
  body: JSON.stringify(state),
 });
 const pushRes = await workerModule.fetch(pushReq, env, {});
 assert.equal(pushRes.status, 200);

 const getRes = await workerModule.fetch(
  new Request('https://bot-dis-2.botmusicvip.workers.dev/api/now-playing'),
  env,
  {},
 );
 const body = await getRes.json();
 assert.equal(body.track.sourceLabel, 'Tệp nhạc / Video');
 assert.equal(body.track.webAudio.kind, 'progressive');
 assert.equal(body.track.webAudio.url, webAudio.url);
});
