import { execFile } from 'node:child_process';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
 cleanYouTubeMetadata,
 extractYouTubePlaylistId,
 extractYouTubeVideoId,
 resolveSingleYouTubeMeta,
 resolveYouTubeCollection,
} from './policy.js';

const execFileAsync = promisify(execFile);
const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_DATA_DIR = join(PROJECT_ROOT, '.data');
const DEFAULT_CIPHER_FILE = join(DEFAULT_DATA_DIR, 'yt-cipher.json');

const PLAYER_ID_TTL_MS = 45 * 60 * 1000;
const REQUEST_KEY = 'O43z0dpjhgX20SCx4KAo';
const CHROME_UA =
 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36';

const YT_SEARCH_FIELD_MASK = [
 'contents.twoColumnSearchResultsRenderer.primaryContents.sectionListRenderer.contents.itemSectionRenderer.contents.videoRenderer.videoId',
 'contents.twoColumnSearchResultsRenderer.primaryContents.sectionListRenderer.contents.itemSectionRenderer.contents.videoRenderer.title',
 'contents.twoColumnSearchResultsRenderer.primaryContents.sectionListRenderer.contents.itemSectionRenderer.contents.videoRenderer.ownerText',
 'contents.twoColumnSearchResultsRenderer.primaryContents.sectionListRenderer.contents.itemSectionRenderer.contents.videoRenderer.lengthText',
].join(',');

const SABR_CLIENTS = [
 {
  name: 'WEB_REMIX',
  id: 67,
  version: '1.20250219.01.00',
  origin: 'https://music.youtube.com',
  endpoint: 'https://music.youtube.com/youtubei/v1/player?prettyPrint=false',
 },
 {
  name: 'WEB',
  id: 1,
  version: '2.20250220.01.00',
  origin: 'https://www.youtube.com',
  endpoint: 'https://www.youtube.com/youtubei/v1/player?prettyPrint=false',
 },
];

const UNPLAYABLE_TITLE_RE = /^(?:\[(?:deleted|private)\s+video\]|deleted\s+video|private\s+video|video\s+đã\s+bị\s+xóa|video\s+riêng\s+tư)$/i;

function readYtRunsText(node) {
 if (!node) return '';
 if (typeof node.simpleText === 'string') return node.simpleText.trim();
 if (Array.isArray(node.runs)) return node.runs.map(r => r?.text ?? '').join('').trim();
 return '';
}

function parseClockDurationMs(raw) {
 const txt = String(raw ?? '').trim();
 if (!/^\d{1,2}(?::\d{2}){1,2}$/.test(txt)) return 0;
 const parts = txt.split(':').map(Number);
 if (parts.some(n => !Number.isFinite(n) || n < 0)) return 0;
 return parts.reduce((acc, cur) => acc * 60 + cur, 0) * 1000;
}

// Tìm kiếm trực tiếp trên YouTube qua JSON FieldMask siêu nhẹ (~18 KB, 0 MB JSDOM) khi gõ tiền tố "yt: <tên bài>".
export async function searchYouTubeVideos(query, { limit = 10, fetchImpl = fetch, signal } = {}) {
 const cleanQ = String(query ?? '').replace(/^(?:yt|youtube):\s*/i, '').trim();
 if (!cleanQ) return [];

 const reqSignal = signal
  ? AbortSignal.any([signal, AbortSignal.timeout(8000)])
  : AbortSignal.timeout(8000);

 const res = await fetchImpl('https://www.youtube.com/youtubei/v1/search?prettyPrint=false', {
  method: 'POST',
  signal: reqSignal,
  headers: {
   'Content-Type': 'application/json',
   'User-Agent': CHROME_UA,
   'X-Goog-FieldMask': YT_SEARCH_FIELD_MASK,
  },
  body: JSON.stringify({
   context: { client: { clientName: 'WEB', clientVersion: '2.20250101.01.00', hl: 'vi', gl: 'VN' } },
   query: cleanQ,
  }),
 });
 if (!res?.ok) return [];
 const data = await res.json();
 const sections =
  data?.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents ?? [];

 const out = [];
 const seen = new Set();
 for (const sec of sections) {
  const items = sec?.itemSectionRenderer?.contents ?? [];
  for (const entry of items) {
   const vr = entry?.videoRenderer;
   const vid = String(vr?.videoId ?? '').trim();
   if (!vid || seen.has(vid) || !/^[A-Za-z0-9_-]{3,20}$/.test(vid)) continue;
   const rawTitle = readYtRunsText(vr.title);
   if (!rawTitle || UNPLAYABLE_TITLE_RE.test(rawTitle)) continue;
   const durTxt = readYtRunsText(vr.lengthText);
   // Bỏ qua livestream (không có lengthText cố định) hoặc video dài trên 180 phút.
   if (!durTxt) continue;
   const durationMs = parseClockDurationMs(durTxt);
   if (durationMs <= 0 || durationMs > 10_800_000) continue;

   const rawAuthor = readYtRunsText(vr.ownerText);
   const cleaned = cleanYouTubeMetadata(rawTitle, rawAuthor);
   seen.add(vid);
   out.push({
    videoId: vid,
    url: `https://www.youtube.com/watch?v=${vid}`,
    title: rawTitle,
    cleanTitle: cleaned.title || rawTitle,
    artist: cleaned.artist || rawAuthor.replace(/\s*-\s*Topic$/i, '').trim() || 'YouTube',
    durationMs,
    thumbnail: `https://i.ytimg.com/vi/${vid}/hqdefault.jpg`,
   });
   if (out.length >= limit) return out;
  }
 }
 return out;
}

function buildCipherRunner(outputJs) {
 const fn = new Function(
  'n',
  'sp',
  's',
  `${outputJs}
const mockStreamingURL = "https://ytjs.googlevideo.com/videoplayback?expire=1234567890&n=" + encodeURIComponent(n || "");
const urlCtorFunction = exportedVars.nsigFunction || (() => { throw new Error("Missing nsigFunction"); });
const urlCtor = urlCtorFunction(mockStreamingURL, sp || "", s || "");
const proto = Object.getPrototypeOf(urlCtor);
for (const prop of Object.getOwnPropertyNames(proto)) {
 if (prop === "constructor" || prop === "clone" || prop === "set" || prop === "get") continue;
 if (typeof urlCtor[prop] === "function") urlCtor[prop]();
}
const sigResult = urlCtor.get(sp || "");
const nResult = urlCtor.get("n");
return {
 sig: sigResult ? decodeURIComponent(sigResult) : undefined,
 n: nResult ? decodeURIComponent(nResult) : undefined,
};`,
 );
 const nCache = new Map();
 return function decipherYouTubeUrl(rawUrl, signatureCipher = '') {
  const args = signatureCipher ? new URLSearchParams(signatureCipher) : null;
  const u = new URL(args?.get('url') || rawUrl);
  const rawN = u.searchParams.get('n');
  const rawS = args?.get('s') || '';
  const sp = args?.get('sp') || 'sig';

  if (rawN && !rawS && nCache.has(rawN)) {
   u.searchParams.set('n', nCache.get(rawN));
  } else if (rawN || rawS) {
   const out = fn(rawN || '', sp, rawS);
   if (rawN && out?.n && !out.n.startsWith('enhanced_except_')) {
    if (nCache.size >= 64) nCache.clear();
    nCache.set(rawN, out.n);
    u.searchParams.set('n', out.n);
   }
   if (rawS && out?.sig) {
    u.searchParams.set(sp, out.sig);
   }
  }

  const clientParam = u.searchParams.get('c');
  if (clientParam === 'WEB_REMIX') u.searchParams.set('cver', SABR_CLIENTS[0].version);
  else if (clientParam === 'WEB') u.searchParams.set('cver', SABR_CLIENTS[1].version);
  return u.toString();
 };
}

async function fetchCurrentYouTubePlayerId(fetchImpl = fetch) {
 const res = await fetchImpl('https://www.youtube.com/iframe_api', {
  signal: AbortSignal.timeout(7000),
  headers: { 'User-Agent': CHROME_UA },
 });
 if (!res?.ok) throw new Error(`HTTP ${res?.status ?? 0}`);
 const text = await res.text();
 const match = text.match(/player\\\/([a-zA-Z0-9_-]{6,20})\\\//);
 return match?.[1] ?? null;
}

// Tách hàm giải mã n/sig của base.js (~177 KB) trong tiến trình con ngắn hạn rồi ghi đệm ra đĩa (.data/yt-cipher.json).
// Nhờ đó tiến trình Bot chính KHÔNG bao giờ phải nạp cây AST ~200 MB của youtubei.js, giữ RAM cực thấp cho gói 512MB!
async function runChildCipherExtraction(playerIdHint = '') {
 const helperCode = `
import { Player, Platform } from "youtubei.js";
Platform.shim.eval = async (data) => new Function(data.output)();
const pid = process.argv[1] || undefined;
const p = await Player.create(null, fetch, undefined, pid);
if (!p?.data?.output) throw new Error("Empty cipher output");
process.stdout.write(JSON.stringify({
 playerId: p.player_id,
 sts: Number(p.signature_timestamp) || 0,
 output: p.data.output,
}));
`;
 try {
  const args = ['--max-old-space-size=192', '--input-type=module', '-e', helperCode];
  if (playerIdHint) args.push('--', playerIdHint);
  const { stdout } = await execFileAsync(process.execPath, args, {
   cwd: PROJECT_ROOT,
   timeout: 25_000,
   maxBuffer: 4 * 1024 * 1024,
  });
  return JSON.parse(stdout);
 } catch {
  // Dự phòng ngay trong tiến trình nếu môi trường host chặn tạo tiến trình con Node phụ.
  const { Player, Platform } = await import('youtubei.js');
  Platform.shim.eval = async data => new Function(data.output)();
  const p = await Player.create(null, fetch, undefined, playerIdHint || undefined);
  return {
   playerId: p.player_id,
   sts: Number(p.signature_timestamp) || 0,
   output: p.data.output,
  };
 }
}

function mapRawFormatToSabr(buildSabrFormat, f) {
 return buildSabrFormat({
  itag: f.itag,
  url: f.url,
  mime_type: f.mimeType,
  bitrate: f.bitrate,
  width: f.width,
  height: f.height,
  last_modified: f.lastModified,
  content_length: f.contentLength,
  quality: f.quality,
  fps: f.fps,
  quality_label: f.qualityLabel,
  projection_type: f.projectionType,
  average_bitrate: f.averageBitrate,
  approx_duration_ms: f.approxDurationMs,
  audio_sample_rate: f.audioSampleRate,
  audio_channels: f.audioChannels,
  audio_quality: f.audioQuality,
  loudness_db: f.loudnessDb,
  is_drc: f.isDrc,
  audio_track: f.audioTrack
   ? {
      audio_is_default: f.audioTrack.audioIsDefault,
      display_name: f.audioTrack.displayName,
      id: f.audioTrack.id,
     }
   : undefined,
  init_range: f.initRange
   ? { start: Number(f.initRange.start), end: Number(f.initRange.end) }
   : undefined,
  index_range: f.indexRange
   ? { start: Number(f.indexRange.start), end: Number(f.indexRange.end) }
   : undefined,
 });
}

export function createNativeYouTubePlugin({
 ffmpegPath = 'ffmpeg',
 cipherCacheFile = DEFAULT_CIPHER_FILE,
 onTrackMetaSynced = null,
} = {}) {
 let compiledCipher = null; // { playerId, sts, decipherUrl, checkedAt }
 let inflightCipherPromise = null;

 let sharedDomReady = false;
 let cachedPoMinter = null; // { minter, expiresAt }
 let inflightMinterPromise = null;
 let sabrModules = null;

 async function ensureCipher({ forceRefresh = false } = {}) {
  const now = Date.now();
  if (!forceRefresh && compiledCipher && now - compiledCipher.checkedAt < PLAYER_ID_TTL_MS) {
   return compiledCipher;
  }
  if (inflightCipherPromise) return inflightCipherPromise;

  inflightCipherPromise = (async () => {
   let livePlayerId = null;
   try {
    livePlayerId = await fetchCurrentYouTubePlayerId();
   } catch {}

   if (!forceRefresh && compiledCipher && (!livePlayerId || compiledCipher.playerId === livePlayerId)) {
    compiledCipher.checkedAt = Date.now();
    return compiledCipher;
   }

   if (!forceRefresh) {
    try {
     const diskRaw = await readFile(cipherCacheFile, 'utf8');
     const parsed = JSON.parse(diskRaw);
     if (
      parsed?.output &&
      parsed?.playerId &&
      (!livePlayerId || parsed.playerId === livePlayerId)
     ) {
      compiledCipher = {
       playerId: parsed.playerId,
       sts: Number(parsed.sts) || 0,
       decipherUrl: buildCipherRunner(parsed.output),
       checkedAt: Date.now(),
      };
      return compiledCipher;
     }
    } catch {}
   }

   const extracted = await runChildCipherExtraction(livePlayerId || '');
   if (!extracted?.output) {
    throw new Error('Không thể khởi tạo bộ giải mã luồng YouTube.');
   }

   try {
    await mkdir(dirname(cipherCacheFile), { recursive: true });
    const tmpPath = `${cipherCacheFile}.${process.pid}.tmp`;
    await writeFile(
     tmpPath,
     JSON.stringify({
      playerId: extracted.playerId,
      sts: extracted.sts,
      output: extracted.output,
      savedAt: Date.now(),
     }),
     'utf8',
    );
    await rename(tmpPath, cipherCacheFile);
   } catch {}

   compiledCipher = {
    playerId: extracted.playerId,
    sts: Number(extracted.sts) || 0,
    decipherUrl: buildCipherRunner(extracted.output),
    checkedAt: Date.now(),
   };
   return compiledCipher;
  })().finally(() => {
   inflightCipherPromise = null;
  });

  return inflightCipherPromise;
 }

 async function mintPoToken(videoId, signal) {
  const now = Date.now();
  if (cachedPoMinter && now < cachedPoMinter.expiresAt) {
   return cachedPoMinter.minter.mintAsWebsafeString(videoId);
  }

  if (!inflightMinterPromise) {
   inflightMinterPromise = (async () => {
    const [{ JSDOM, VirtualConsole }, bg, bgu, bgw] = await Promise.all([
     import('jsdom'),
     import('bgutils-js/botguard'),
     import('bgutils-js/utils'),
     import('bgutils-js/webpo'),
    ]);

    if (!sharedDomReady) {
     const virtualConsole = new VirtualConsole();
     const dom = new JSDOM(
      '<!DOCTYPE html><html lang="en"><head><title></title></head><body></body></html>',
      {
       url: 'https://www.youtube.com/',
       referrer: 'https://www.youtube.com/',
       userAgent: bgu.USER_AGENT,
       virtualConsole,
      },
     );
     Object.assign(globalThis, {
      window: dom.window,
      document: dom.window.document,
      location: dom.window.location,
      origin: dom.window.origin,
     });
     if (!Reflect.has(globalThis, 'navigator')) {
      Object.defineProperty(globalThis, 'navigator', {
       value: dom.window.navigator,
       configurable: true,
      });
     }
     sharedDomReady = true;
    }

    const challenge = await bg.getChallenge({ fetchFunction: fetch, requestKey: REQUEST_KEY });
    const interpreterJs =
     challenge?.interpreterJavascript?.privateDoNotAccessOrElseSafeScriptWrappedValue;
    if (!interpreterJs) {
     throw new Error('Không lấy được thử thách BotGuard từ YouTube.');
    }
    new Function(interpreterJs)();

    const botGuardClient = await bg.BotGuardClient.create({
     program: challenge.program,
     globalName: challenge.globalName,
     globalObject: globalThis,
    });
    const webPoSignalOutput = [];
    const botguardResponse = await botGuardClient.snapshot({ webPoSignalOutput });

    const res = await fetch(bgu.buildURL('GenerateIT', true), {
     method: 'POST',
     headers: bgu.getHeaders(),
     body: JSON.stringify([REQUEST_KEY, botguardResponse]),
     signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
     throw new Error(`GenerateIT thất bại: HTTP ${res.status}`);
    }
    const [integrityToken, estimatedTtlSecs, mintRefreshThreshold, websafeFallbackToken] =
     await res.json();
    const minter = await bgw.WebPoMinter.create(
     { integrityToken, estimatedTtlSecs, mintRefreshThreshold, websafeFallbackToken },
     webPoSignalOutput,
    );
    const ttlMs = Math.max(300, (Number(estimatedTtlSecs) || 3600) - 300) * 1000;
    cachedPoMinter = {
     minter,
     expiresAt: Date.now() + ttlMs,
    };
    return cachedPoMinter;
   })().finally(() => {
    inflightMinterPromise = null;
   });
  }

  const holder = await inflightMinterPromise;
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  return holder.minter.mintAsWebsafeString(videoId);
 }

 async function loadSabrModules() {
  if (!sabrModules) {
   const [{ SabrStream }, { buildSabrFormat, EnabledTrackTypes }] = await Promise.all([
    import('googlevideo/sabr-stream'),
    import('googlevideo/utils'),
   ]);
   sabrModules = { SabrStream, buildSabrFormat, EnabledTrackTypes };
  }
  return sabrModules;
 }

 async function fetchSabrPlayerPayload(videoId, poToken, sts, clientCfg, signal) {
  const reqSignal = signal
   ? AbortSignal.any([signal, AbortSignal.timeout(10_000)])
   : AbortSignal.timeout(10_000);
  const res = await fetch(clientCfg.endpoint, {
   method: 'POST',
   signal: reqSignal,
   headers: {
    'Content-Type': 'application/json',
    'Origin': clientCfg.origin,
    'Referer': `${clientCfg.origin}/`,
    'X-YouTube-Client-Name': String(clientCfg.id),
    'X-YouTube-Client-Version': clientCfg.version,
    'User-Agent': CHROME_UA,
   },
   body: JSON.stringify({
    videoId,
    context: {
     client: {
      clientName: clientCfg.name,
      clientVersion: clientCfg.version,
      hl: 'vi',
      gl: 'VN',
     },
    },
    playbackContext: {
     contentPlaybackContext: {
      signatureTimestamp: sts,
      html5Preference: 'HTML5_PREF_WANTS',
     },
    },
    serviceIntegrityDimensions: { poToken },
    contentCheckOk: true,
    racyCheckOk: true,
   }),
  });
  if (!res.ok) throw new Error(`YouTube player HTTP ${res.status}`);
  return res.json();
 }

 async function openRawSabrStream(
  videoId,
  { signal, track = null, seekMs = 0, allowCipherRetry = true } = {},
 ) {
  // QUAN TRỌNG: Nạp cipher trước khi nạp JSDOM để đỉnh RAM không bao giờ chồng nhau trên gói 512MB!
  const cipher = await ensureCipher({ forceRefresh: false });
  const [poToken, { SabrStream, buildSabrFormat, EnabledTrackTypes }] = await Promise.all([
   mintPoToken(videoId, signal),
   loadSabrModules(),
  ]);

  let chosenClient = null;
  let playerData = null;
  let lastReason = '';

  for (const clientCfg of SABR_CLIENTS) {
   try {
    const data = await fetchSabrPlayerPayload(videoId, poToken, cipher.sts, clientCfg, signal);
    const status = data?.playabilityStatus?.status;
    const hasSabr = Boolean(
     data?.streamingData?.serverAbrStreamingUrl &&
     data?.streamingData?.adaptiveFormats?.length &&
     data?.playerConfig?.mediaCommonConfig?.mediaUstreamerRequestConfig?.videoPlaybackUstreamerConfig,
    );
    if (status === 'OK' && hasSabr) {
     chosenClient = clientCfg;
     playerData = data;
     break;
    }
    lastReason = data?.playabilityStatus?.reason || status || 'UNPLAYABLE';
   } catch (err) {
    lastReason = err?.message || 'Lỗi kết nối YouTube';
   }
  }

  if (!playerData || !chosenClient) {
   throw new Error(`Video YouTube không phát được (${lastReason || 'bị khóa vùng hoặc giới hạn tuổi'}).`);
  }

  const vd = playerData.videoDetails ?? {};
  if (vd.isLiveContent || vd.isLive) {
   throw new Error('Chỉ nhận bài tối đa 180 phút, không nhận phát trực tiếp (livestream).');
  }
  const lenMs = (Number(vd.lengthSeconds) || 0) * 1000;
  if (lenMs > 10_800_000) {
   throw new Error('Chỉ nhận bài tối đa 180 phút, không nhận phát trực tiếp (livestream).');
  }

  if (track && lenMs > 0 && (!track.duration || Math.abs(Number(track.duration) - lenMs) > 4000)) {
   track.duration = lenMs;
   onTrackMetaSynced?.(track);
  }

  const clampedSeekMs = Math.max(
   0,
   lenMs > 2000 ? Math.min(Math.floor(Number(seekMs) || 0), lenMs - 1500) : Math.floor(Number(seekMs) || 0),
  );

  let sabr = null;
  let reloadHandler = null;
  let fmtInitHandler = null;
  try {
   const serverAbrStreamingUrl = cipher.decipherUrl(playerData.streamingData.serverAbrStreamingUrl);
   const ustreamerConfig =
    playerData.playerConfig.mediaCommonConfig.mediaUstreamerRequestConfig.videoPlaybackUstreamerConfig;
   const formats = playerData.streamingData.adaptiveFormats.map(f =>
    mapRawFormatToSabr(buildSabrFormat, f),
   );

   sabr = new SabrStream({
    formats,
    serverAbrStreamingUrl,
    videoPlaybackUstreamerConfig: ustreamerConfig,
    poToken,
    clientInfo: { clientName: chosenClient.id, clientVersion: chosenClient.version },
   });

   // Tua thẳng ở tầng giao thức SABR trên máy chủ Google (~0.5s, không cần chạy thêm tiến trình FFmpeg).
   if (clampedSeekMs >= 500) {
    const origBuildBody = sabr.buildRequestBody.bind(sabr);
    sabr.buildRequestBody = function patchedSeekBuildBody(abrState, selAudio, selVideo) {
     if (Number(abrState.playerTimeMs || 0) < clampedSeekMs) {
      abrState.playerTimeMs = String(clampedSeekMs);
     }
     return origBuildBody(abrState, selAudio, selVideo);
    };
    fmtInitHandler = initializedFmt => {
     if (initializedFmt?.downloadedSegments && !initializedFmt.downloadedSegments.has(-1)) {
      initializedFmt.downloadedSegments.set(-1, {
       durationMs: String(clampedSeekMs),
       segmentNumber: -1,
       mediaHeader: {},
      });
     }
    };
    sabr.on('formatInitialization', fmtInitHandler);
   }

   reloadHandler = async () => {
    try {
     if (signal?.aborted) return;
     const [freshCipher, refreshedPo] = await Promise.all([
      ensureCipher({ forceRefresh: false }),
      mintPoToken(videoId, signal),
     ]);
     const reloaded = await fetchSabrPlayerPayload(
      videoId,
      refreshedPo,
      freshCipher.sts,
      chosenClient,
      signal,
     );
     const nextUrlRaw = reloaded?.streamingData?.serverAbrStreamingUrl;
     const nextCfg =
      reloaded?.playerConfig?.mediaCommonConfig?.mediaUstreamerRequestConfig?.videoPlaybackUstreamerConfig;
     const nextFormats = (reloaded?.streamingData?.adaptiveFormats ?? []).map(f =>
      mapRawFormatToSabr(buildSabrFormat, f),
     );
     sabr?.setPoToken(refreshedPo);
     if (nextUrlRaw) sabr?.setStreamingURL(freshCipher.decipherUrl(nextUrlRaw));
     if (nextCfg) sabr?.setUstreamerConfig(nextCfg);
     if (nextFormats.length) sabr?.setServerAbrFormats(nextFormats);
    } catch {}
   };

   sabr.on('reloadPlayerResponse', reloadHandler);

   const started = await sabr.start({
    enabledTrackTypes: EnabledTrackTypes.AUDIO_ONLY,
    audioQuality: 'medium',
    preferWebM: true,
    preferOpus: true,
   });
   if (!started?.audioStream) {
    throw new Error('SABR không trả về luồng âm thanh.');
   }
   try {
    void started.videoStream?.cancel?.('Audio only');
   } catch {}

   const reader = started.audioStream.getReader();
   const sabrRef = sabr;
   let cleanedUp = false;
   let pulling = false;

   const teardown = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    if (reloadHandler) {
     try { sabrRef.off('reloadPlayerResponse', reloadHandler); } catch {}
    }
    if (fmtInitHandler) {
     try { sabrRef.off('formatInitialization', fmtInitHandler); } catch {}
    }
    try { void reader.cancel(); } catch {}
    try { reader.releaseLock(); } catch {}
    try { sabrRef.abort(); } catch {}
   };

   const nodeStream = new Readable({
    highWaterMark: 64 * 1024,
    read() {
     if (pulling || cleanedUp) return;
     pulling = true;
     void (async () => {
      try {
       while (!cleanedUp && !this.destroyed) {
        if (signal?.aborted) {
         teardown();
         this.push(null);
         break;
        }
        const { done, value } = await reader.read();
        if (cleanedUp || this.destroyed) break;
        if (done) {
         teardown();
         this.push(null);
         break;
        }
        if (value?.byteLength) {
         const keepReading = this.push(Buffer.from(value));
         if (!keepReading) break;
        }
       }
      } catch (err) {
       if (!cleanedUp && !this.destroyed) {
        teardown();
        this.destroy(err instanceof Error ? err : new Error(String(err)));
       }
      } finally {
       pulling = false;
      }
     })();
    },
    destroy(err, callback) {
     teardown();
     callback(err);
    },
   });

   if (signal) {
    signal.addEventListener('abort', () => nodeStream.destroy(), { once: true });
   }

   return nodeStream;
  } catch (err) {
   if (sabr) {
    if (reloadHandler) {
     try { sabr.off('reloadPlayerResponse', reloadHandler); } catch {}
    }
    if (fmtInitHandler) {
     try { sabr.off('formatInitialization', fmtInitHandler); } catch {}
    }
    try { sabr.abort(); } catch {}
   }
   if (allowCipherRetry && !signal?.aborted) {
    await ensureCipher({ forceRefresh: true }).catch(() => {});
    return openRawSabrStream(videoId, { signal, track, seekMs, allowCipherRetry: false });
   }
   throw err;
  }
 }

 async function openSeekedSabrStream(videoId, positionMs, { signal, track = null } = {}) {
  return openRawSabrStream(videoId, { signal, track, seekMs: positionMs });
 }

 function buildYouTubeTrack(item, requestedBy) {
  return {
   id: String(item.videoId),
   title: item.title,
   url: item.url || `https://www.youtube.com/watch?v=${item.videoId}`,
   duration: Number(item.durationMs) || 0,
   thumbnail: item.thumbnail || `https://i.ytimg.com/vi/${item.videoId}/hqdefault.jpg`,
   requestedBy,
   source: 'youtube',
   metadata: {
    author: item.artist || 'YouTube',
    cleanTitle: item.cleanTitle || item.title,
   },
  };
 }

 return {
  name: 'youtube',
  version: '2.0.0',
  priority: 30,

  validate(url) {
   const raw = String(url ?? '').trim();
   if (!raw.startsWith('https://')) return false;
   try {
    return Boolean(extractYouTubeVideoId(raw) || extractYouTubePlaylistId(raw));
   } catch {
    return false;
   }
  },

  canHandle(query) {
   const q = String(query ?? '').trim();
   if (/^(?:yt|youtube):\s*\S+/i.test(q)) return true;
   return this.validate(q);
  },

  async search(query, requestedBy, signal) {
   const trimmed = String(query ?? '').trim();
   if (!trimmed) return { tracks: [] };

   if (/^(?:yt|youtube):\s*/i.test(trimmed)) {
    const items = await searchYouTubeVideos(trimmed, { limit: 10, signal });
    return { tracks: items.map(it => buildYouTubeTrack(it, requestedBy)) };
   }

   if (!trimmed.startsWith('https://')) {
    return { tracks: [] };
   }

   let playlistId = null;
   let videoId = null;
   try {
    playlistId = extractYouTubePlaylistId(trimmed);
    videoId = extractYouTubeVideoId(trimmed);
   } catch {
    return { tracks: [] };
   }
   if (!playlistId && !videoId) return { tracks: [] };

   if (playlistId) {
    const col = await resolveYouTubeCollection({ playlistId, videoId });
    if (col?.items?.length) {
     return {
      tracks: col.items.map(it => buildYouTubeTrack(it, requestedBy)),
      playlist: {
       name: col.name,
       url: trimmed,
       thumbnail: col.thumbnail ?? undefined,
      },
     };
    }
   }

   if (!videoId) return { tracks: [] };
   const meta = await resolveSingleYouTubeMeta(videoId);
   if (!meta || meta.isLive || Number(meta.durationMs) > 10_800_000) return { tracks: [] };
   const cleaned = cleanYouTubeMetadata(meta.rawTitle, meta.rawAuthor);
   const rawTitleClean = String(meta.rawTitle ?? '').replace(/\s+/g, ' ').trim();
   if (!rawTitleClean) return { tracks: [] };

   return {
    tracks: [
     buildYouTubeTrack(
      {
       videoId,
       url: `https://www.youtube.com/watch?v=${videoId}`,
       title: rawTitleClean,
       cleanTitle: cleaned.title || rawTitleClean,
       artist: cleaned.artist || String(meta.rawAuthor ?? '').replace(/\s*-\s*Topic$/i, '').trim() || 'YouTube',
       durationMs: Number(meta.durationMs) || 0,
       thumbnail: meta.thumbnail,
      },
      requestedBy,
     ),
    ],
   };
  },

  async getStream(track, signal) {
   const videoId = extractYouTubeVideoId(String(track?.url ?? '')) || String(track?.id ?? '').trim();
   if (!/^[A-Za-z0-9_-]{3,20}$/.test(videoId)) {
    throw new Error('Mã video YouTube không hợp lệ.');
   }
   const stream = await openRawSabrStream(videoId, { signal, track });
   return {
    stream,
    type: 'arbitrary',
    recreate: positionMs => openSeekedSabrStream(videoId, positionMs, { track }),
    metadata: {
     title: track?.title,
     author: track?.metadata?.author,
    },
   };
  },

  async getRelatedTracks(track, opts = {}) {
   if (String(track?.source ?? '').toLowerCase() !== 'youtube' && !this.validate(track?.url)) {
    return [];
   }
   const videoId = extractYouTubeVideoId(String(track?.url ?? '')) || String(track?.id ?? '').trim();
   if (!/^[A-Za-z0-9_-]{3,20}$/.test(videoId)) return [];

   try {
    const mix = await resolveYouTubeCollection({
     playlistId: `RD${videoId}`,
     videoId,
    });
    if (!mix?.items?.length) return [];
    const wantLimit = opts?.limit || 5;
    const offset = opts?.offset || 0;
    const historyUrls = new Set((opts?.history ?? []).map(h => h?.url).filter(Boolean));
    const historyIds = new Set(
     (opts?.history ?? [])
      .map(h => extractYouTubeVideoId(String(h?.url ?? '')) || h?.id)
      .filter(Boolean),
    );
    historyIds.add(videoId);

    return mix.items
     .filter(
      it =>
       it.videoId &&
       !historyIds.has(it.videoId) &&
       !historyUrls.has(it.url) &&
       it.durationMs > 35_000 &&
       it.durationMs <= 10_800_000,
     )
     .slice(offset, offset + wantLimit)
     .map(it => buildYouTubeTrack(it, 'auto'));
   } catch {
    return [];
   }
  },
 };
}
