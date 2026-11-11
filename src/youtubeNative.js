import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
 cleanYouTubeMetadata,
 ensureYouTubeVisitorSession,
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
const VISIONOS_UA =
 'Mozilla/5.0 (Macintosh; Intel Mac OS X 15_7_3) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15';

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
  version: '2.20261030.02.00',
  useLiveWebVersion: true,
  origin: 'https://www.youtube.com',
  endpoint: 'https://www.youtube.com/youtubei/v1/player?prettyPrint=false',
 },
 {
  name: 'MWEB',
  id: 2,
  version: '2.20260205.04.01',
  origin: 'https://m.youtube.com',
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

function resolveHlsUri(rawUri, baseUrl) {
 const trimmed = String(rawUri ?? '').trim();
 if (!trimmed) return null;
 try {
  const u = baseUrl ? new URL(trimmed, baseUrl) : new URL(trimmed);
  return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : null;
 } catch {
  return null;
 }
}

// Chọn luồng âm thanh chất lượng cao nhất trong HLS Master Playlist của YouTube (ưu tiên itag/234 AAC 128-160k -> itag/233 -> TYPE=AUDIO bất kỳ).
export function parseYouTubeHlsMasterAudioUrl(masterText, masterUrl = '') {
 if (typeof masterText !== 'string' || !masterText.includes('#EXTM3U')) return null;
 const lines = masterText.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
 const audioCandidates = [];

 for (const line of lines) {
  if (!line.startsWith('#EXT-X-MEDIA:')) continue;
  if (!/TYPE=AUDIO\b/i.test(line)) continue;
  const uriMatch = line.match(/URI="([^"]+)"/i);
  const resolved = uriMatch?.[1] ? resolveHlsUri(uriMatch[1], masterUrl) : null;
  if (!resolved) continue;
  const groupMatch = line.match(/GROUP-ID="([^"]+)"/i);
  const groupId = groupMatch?.[1] ?? '';
  let score = 10;
  if (groupId === '234' || /\/itag\/(?:234|140|141)\b/.test(resolved)) score = 100;
  else if (groupId === '233' || /\/itag\/(?:233|139)\b/.test(resolved)) score = 50;
  if (/DEFAULT=YES/i.test(line)) score += 5;
  audioCandidates.push({ url: resolved, score });
 }

 if (audioCandidates.length > 0) {
  audioCandidates.sort((a, b) => b.score - a.score);
  return audioCandidates[0].url;
 }

 // Dự phòng nếu playlist master trỏ thẳng tới danh sách phân đoạn hoặc stream đơn.
 for (const line of lines) {
  if (!line.startsWith('#')) {
   const resolved = resolveHlsUri(line, masterUrl);
   if (resolved) return resolved;
  }
 }
 return null;
}

// Giải mã danh sách phân đoạn VOD (#EXTINF + URL + #EXT-X-MAP tùy chọn) để phát trực tiếp & tua tức thì đến đúng mili-giây.
export function parseYouTubeHlsMediaPlaylist(mediaText, mediaUrl = '') {
 if (typeof mediaText !== 'string' || !mediaText.includes('#EXTM3U')) return null;
 const lines = mediaText.split(/\r?\n/).map(l => l.trim()).filter(Boolean);

 let initUrl = null;
 const segments = [];
 let pendingDurMs = 5000;
 let cursorMs = 0;

 for (const line of lines) {
  if (line.startsWith('#EXT-X-MAP:')) {
   const m = line.match(/URI="([^"]+)"/i);
   if (m?.[1]) initUrl = resolveHlsUri(m[1], mediaUrl);
   continue;
  }
  if (line.startsWith('#EXTINF:')) {
   const rawSec = Number.parseFloat(line.slice(8).split(',')[0]);
   pendingDurMs = Number.isFinite(rawSec) && rawSec > 0 ? Math.round(rawSec * 1000) : 5000;
   continue;
  }
  if (!line.startsWith('#')) {
   const segUrl = resolveHlsUri(line, mediaUrl);
   if (segUrl) {
    segments.push({
     url: segUrl,
     durationMs: pendingDurMs,
     startMs: cursorMs,
    });
    cursorMs += pendingDurMs;
   }
   pendingDurMs = 5000;
  }
 }

 if (!segments.length) return null;
 return {
  initUrl,
  segments,
  totalDurationMs: cursorMs,
 };
}

export function findHlsSegmentStartIndex(segments, seekMs = 0) {
 const target = Math.max(0, Math.floor(Number(seekMs) || 0));
 if (!Array.isArray(segments) || !segments.length || target <= 0) return 0;
 for (let i = 0; i < segments.length; i++) {
  const seg = segments[i];
  if (seg.startMs + seg.durationMs > target) return i;
 }
 return Math.max(0, segments.length - 1);
}

// Tìm kiếm trực tiếp trên YouTube qua JSON FieldMask siêu nhẹ (~18 KB, 0 MB JSDOM) khi gõ tiền tố "yt: <tên bài>".
export async function searchYouTubeVideos(query, { limit = 10, fetchImpl = fetch, signal } = {}) {
 const cleanQ = String(query ?? '').replace(/^(?:yt|youtube):\s*/i, '').trim();
 if (!cleanQ) return [];

 const session = await ensureYouTubeVisitorSession({ fetchImpl });
 const reqSignal = signal
  ? AbortSignal.any([signal, AbortSignal.timeout(8000)])
  : AbortSignal.timeout(8000);

 const headers = {
  'Content-Type': 'application/json',
  'User-Agent': CHROME_UA,
  'X-Goog-FieldMask': YT_SEARCH_FIELD_MASK,
  'X-Youtube-Client-Name': '1',
  'X-Youtube-Client-Version': session.webClientVersion || '2.20261030.02.00',
 };
 if (session.visitorData) headers['X-Goog-Visitor-Id'] = session.visitorData;

 const res = await fetchImpl('https://www.youtube.com/youtubei/v1/search?prettyPrint=false', {
  method: 'POST',
  signal: reqSignal,
  headers,
  body: JSON.stringify({
   context: {
    client: {
     clientName: 'WEB',
     clientVersion: session.webClientVersion || '2.20261030.02.00',
     ...(session.visitorData ? { visitorData: session.visitorData } : {}),
     hl: 'vi',
     gl: 'VN',
    },
   },
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
 return function decipherYouTubeUrl(rawUrl, signatureCipher = '', webVer = '2.20261030.02.00') {
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
  else if (clientParam === 'WEB') u.searchParams.set('cver', webVer);
  else if (clientParam === 'MWEB') u.searchParams.set('cver', SABR_CLIENTS[2].version);
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
 const args = ['--max-old-space-size=256', '--input-type=module', '-e', helperCode];
 if (playerIdHint) args.push('--', playerIdHint);
 let lastErr = null;
 for (let attempt = 1; attempt <= 2; attempt++) {
  try {
   const { stdout } = await execFileAsync(process.execPath, args, {
    cwd: PROJECT_ROOT,
    env: { ...process.env, NODE_OPTIONS: '' },
    timeout: 24_000,
    maxBuffer: 4 * 1024 * 1024,
   });
   return JSON.parse(stdout);
  } catch (err) {
   lastErr = err;
  }
 }
 throw lastErr ?? new Error('Không thể giải mã chữ ký luồng YouTube trong tiến trình con.');
}

export function mapRawFormatToSabr(buildSabrFormat, f) {
 return buildSabrFormat({
  itag: f.itag,
  url: f.url,
  xtags: f.xtags,
  mimeType: f.mimeType,
  bitrate: f.bitrate,
  width: f.width,
  height: f.height,
  lastModified: String(f.lastModified ?? f.last_modified_ms ?? '0'),
  contentLength: Number.parseInt(String(f.contentLength ?? '0'), 10) || 0,
  quality: f.quality,
  fps: f.fps,
  qualityLabel: f.qualityLabel,
  projectionType: f.projectionType,
  averageBitrate: f.averageBitrate,
  approxDurationMs: Number.parseInt(String(f.approxDurationMs ?? '0'), 10) || 0,
  audioSampleRate: f.audioSampleRate,
  audioChannels: f.audioChannels,
  audioQuality: f.audioQuality,
  loudnessDb: f.loudnessDb,
  is_drc: Boolean(f.isDrc),
  is_auto_dubbed: Boolean(f.isAutoDubbed),
  is_descriptive: Boolean(f.isDescriptive),
  is_dubbed: Boolean(f.isDubbed),
  language: f.audioTrack?.id ? String(f.audioTrack.id).split('.')[0] : undefined,
  is_original: Boolean(f.audioTrack?.audioIsDefault),
  audioTrackId: f.audioTrack?.id,
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

function createPolicyBlockError(message) {
 const err = new Error(message);
 err.isPolicyBlock = true;
 return err;
}

/**
 * Chuẩn hóa chuỗi YOUTUBE_COOKIE (hỗ trợ cả chuỗi Header "SID=...; SAPISID=..." lẫn định dạng file Netscape cookies.txt)
 * và tự động sinh chữ ký SAPISIDHASH chuẩn xác thực InnerTube cho các bài giới hạn độ tuổi 18+.
 */
export function buildYouTubeCookieAuthHeaders(
 rawInput,
 origin = 'https://www.youtube.com',
 nowSec = Math.floor(Date.now() / 1000),
) {
 let text = String(rawInput ?? '').trim();
 if (!text) return {};
 if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
  text = text.slice(1, -1).trim();
 }

 const jar = new Map();
 const lines = text.split(/\r?\n/);
 const looksLikeNetscape = lines.some(l => {
  const clean = l.startsWith('#HttpOnly_') ? l.slice(10) : l;
  return !clean.startsWith('#') && clean.split('\t').length >= 7;
 });

 if (looksLikeNetscape) {
  for (const rawLine of lines) {
   const trimmed = rawLine.trim();
   if (!trimmed) continue;
   const unprefixed = trimmed.startsWith('#HttpOnly_') ? trimmed.slice(10) : trimmed;
   if (unprefixed.startsWith('#')) continue;
   const cols = unprefixed.split('\t');
   if (cols.length < 7) continue;
   const domain = cols[0].trim().toLowerCase();
   if (domain !== 'youtube.com' && !domain.endsWith('.youtube.com')) continue;
   const exp = Number(cols[4]);
   if (Number.isFinite(exp) && exp > 0 && exp < nowSec) continue;
   const name = cols[5].trim();
   const val = cols[6].trim();
   if (name && !/[\r\n;\x00-\x1f]/.test(name) && !/[\r\n\x00-\x1f]/.test(val)) {
    jar.set(name, val);
   }
  }
 } else {
  const singleLine = text.replace(/^cookie\s*:\s*/i, '').replace(/[\r\n]+/g, ' ').trim();
  for (const part of singleLine.split(';')) {
   const eq = part.indexOf('=');
   if (eq <= 0) continue;
   const name = part.slice(0, eq).trim();
   const val = part.slice(eq + 1).trim();
   if (name && !/[\r\n;\x00-\x1f]/.test(name) && !/[\r\n\x00-\x1f]/.test(val)) {
    jar.set(name, val);
   }
  }
 }

 if (jar.size === 0) return {};
 const cookieHeader = Array.from(jar.entries())
  .map(([k, v]) => `${k}=${v}`)
  .join('; ');
 const headers = { Cookie: cookieHeader };

 const sapisid =
  jar.get('SAPISID') || jar.get('__Secure-3PAPISID') || jar.get('__Secure-1PAPISID') || '';
 if (sapisid) {
  const digest = createHash('sha1').update(`${nowSec} ${sapisid} ${origin}`).digest('hex');
  headers.Authorization = `SAPISIDHASH ${nowSec}_${digest}`;
  headers['X-Origin'] = origin;
  headers['X-Goog-AuthUser'] = '0';
 }
 return headers;
}

export function createNativeYouTubePlugin({
 ffmpegPath: _ffmpegPath = 'ffmpeg',
 cipherCacheFile = DEFAULT_CIPHER_FILE,
 cookieFilePath = '',
 onTrackMetaSynced = null,
 fetchImpl = fetch,
} = {}) {
 let compiledCipher = null;
 let inflightCipherPromise = null;

 let sharedDomReady = false;
 let lastBotGuardGlobalName = null;
 let cachedPoMinter = null; // { minter, expiresAt }
 let inflightMinterPromise = null;
 let sabrModules = null;
 let cachedDiskCookie = { value: '', checkedAt: 0 };

 async function readOptionalCookieRaw() {
  const envVal = String(process.env.YOUTUBE_COOKIE ?? '').trim();
  if (envVal) return envVal;

  const now = Date.now();
  if (now - cachedDiskCookie.checkedAt < 30_000) return cachedDiskCookie.value;
  cachedDiskCookie.checkedAt = now;

  for (const candidate of [
   cookieFilePath,
   process.env.YOUTUBE_COOKIE_FILE,
   join(PROJECT_ROOT, 'cookies.txt'),
   join(PROJECT_ROOT, 'youtube-cookies.txt'),
   join(DEFAULT_DATA_DIR, 'cookies.txt'),
  ].filter(Boolean)) {
   try {
    const content = (await readFile(candidate, 'utf8')).trim();
    if (content) {
     cachedDiskCookie.value = content;
     return content;
    }
   } catch {}
  }
  cachedDiskCookie.value = '';
  return '';
 }

 async function ensureCipher({ forceRefresh = false } = {}) {
  const now = Date.now();
  if (!forceRefresh && compiledCipher && now - compiledCipher.checkedAt < PLAYER_ID_TTL_MS) {
   return compiledCipher;
  }
  if (inflightCipherPromise) return inflightCipherPromise;

  inflightCipherPromise = (async () => {
   let livePlayerId = null;
   try {
    livePlayerId = await fetchCurrentYouTubePlayerId(fetchImpl);
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

 // Khởi tạo BotGuard WebPO an toàn tuyệt đối trên cả Node 20 lẫn Node 22+ (ghi đè navigator.userAgent chuẩn Chrome, không lộ Node.js/22 hay jsdom/28).
 async function mintPoToken(contentBinding, signal) {
  if (!contentBinding) throw new Error('Thiếu định danh để tạo PoToken.');
  const now = Date.now();
  if (cachedPoMinter && now < cachedPoMinter.expiresAt) {
   return cachedPoMinter.minter.mintAsWebsafeString(contentBinding);
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
      '<!DOCTYPE html><html lang="en"><head><title>YouTube</title></head><body></body></html>',
      {
       url: 'https://www.youtube.com/',
       referrer: 'https://www.youtube.com/',
       userAgent: bgu.USER_AGENT,
       virtualConsole,
      },
     );
     try {
      Object.defineProperty(dom.window.navigator, 'userAgent', {
       get: () => bgu.USER_AGENT,
       configurable: true,
      });
      Object.defineProperty(dom.window.navigator, 'webdriver', {
       get: () => false,
       configurable: true,
      });
     } catch {}

     for (const [k, v] of Object.entries({
      window: dom.window,
      document: dom.window.document,
      location: dom.window.location,
      origin: dom.window.origin,
      navigator: dom.window.navigator,
     })) {
      Object.defineProperty(globalThis, k, {
       value: v,
       configurable: true,
       writable: true,
      });
     }
     sharedDomReady = true;
    }

    const challenge = await bg.getChallenge({ fetchFunction: fetchImpl, requestKey: REQUEST_KEY });
    const interpreterJs =
     challenge?.interpreterJavascript?.privateDoNotAccessOrElseSafeScriptWrappedValue;
    if (!interpreterJs) {
     throw new Error('Không lấy được thử thách BotGuard từ YouTube.');
    }
    if (lastBotGuardGlobalName && lastBotGuardGlobalName !== challenge.globalName) {
     try {
      delete globalThis[lastBotGuardGlobalName];
     } catch {}
    }
    lastBotGuardGlobalName = challenge.globalName || null;
    new Function(interpreterJs)();

    const botGuardClient = await bg.BotGuardClient.create({
     program: challenge.program,
     globalName: challenge.globalName,
     globalObject: globalThis,
    });
    const webPoSignalOutput = [];
    const botguardResponse = await botGuardClient.snapshot({ webPoSignalOutput });

    const res = await fetchImpl(bgu.buildURL('GenerateIT', true), {
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
  return holder.minter.mintAsWebsafeString(contentBinding);
 }

 async function fetchBufferWithRetry(url, { signal, ua = VISIONOS_UA, maxAttempts = 3 } = {}) {
  let lastErr = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
   if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
   try {
    const reqSignal = signal
     ? AbortSignal.any([signal, AbortSignal.timeout(10_000)])
     : AbortSignal.timeout(10_000);
    const res = await fetchImpl(url, {
     signal: reqSignal,
     headers: {
      'Accept': '*/*',
      'User-Agent': ua,
      'Origin': 'https://www.youtube.com',
      'Referer': 'https://www.youtube.com/',
     },
    });
    if (res.status === 401 || res.status === 403) {
     const authErr = new Error(`HLS segment HTTP ${res.status}`);
     authErr.status = res.status;
     throw authErr;
    }
    if (!res.ok) throw new Error(`HLS segment HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
   } catch (err) {
    lastErr = err;
    if (signal?.aborted || err?.status === 401 || err?.status === 403 || attempt >= maxAttempts) {
     throw err;
    }
    await new Promise(r => setTimeout(r, 220 * attempt));
   }
  }
  throw lastErr ?? new Error('Không thể tải phân đoạn âm thanh YouTube.');
 }

 async function resolveVisionOsHlsPlan(videoId, { signal, usePoToken = false } = {}) {
  const session = await ensureYouTubeVisitorSession({ fetchImpl });
  let sessionPoToken = '';
  if (usePoToken) {
   sessionPoToken = await mintPoToken(session.visitorData || videoId, signal);
  }

  const reqSignal = signal
   ? AbortSignal.any([signal, AbortSignal.timeout(9000)])
   : AbortSignal.timeout(9000);

  const headers = {
   'Content-Type': 'application/json',
   'Origin': 'https://www.youtube.com',
   'Referer': 'https://www.youtube.com/',
   'User-Agent': VISIONOS_UA,
   'X-Youtube-Client-Name': '101',
   'X-Youtube-Client-Version': '1.02',
  };
  if (session.visitorData) headers['X-Goog-Visitor-Id'] = session.visitorData;

  const res = await fetchImpl('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
   method: 'POST',
   signal: reqSignal,
   headers,
   body: JSON.stringify({
    videoId,
    context: {
     client: {
      clientName: 'VISIONOS',
      clientVersion: '1.02',
      deviceMake: 'Apple',
      deviceModel: 'RealityDevice17,1',
      osName: 'visionOS',
      osVersion: '26.5.23O471',
      ...(session.visitorData ? { visitorData: session.visitorData } : {}),
      hl: 'vi',
      gl: 'VN',
     },
    },
    ...(sessionPoToken ? { serviceIntegrityDimensions: { poToken: sessionPoToken } } : {}),
    contentCheckOk: true,
    racyCheckOk: true,
   }),
  });
  if (!res.ok) throw new Error(`VISIONOS player HTTP ${res.status}`);
  const playerData = await res.json();
  const status = playerData?.playabilityStatus?.status;
  const reason = playerData?.playabilityStatus?.reason || status || 'UNPLAYABLE';

  const vd = playerData?.videoDetails ?? {};
  if (vd.isLiveContent || vd.isLive) {
   throw createPolicyBlockError('Chỉ nhận bài tối đa 180 phút, không nhận phát trực tiếp (livestream).');
  }
  const lenMs = (Number(vd.lengthSeconds) || 0) * 1000;
  if (lenMs > 10_800_000) {
   throw createPolicyBlockError('Chỉ nhận bài tối đa 180 phút, không nhận phát trực tiếp (livestream).');
  }

  const hlsManifestUrl = playerData?.streamingData?.hlsManifestUrl;
  if (status !== 'OK' || !hlsManifestUrl) {
   const err = new Error(`VISIONOS không sẵn sàng (${reason})`);
   err.playabilityStatus = status;
   throw err;
  }

  const masterBuf = await fetchBufferWithRetry(hlsManifestUrl, { signal, maxAttempts: 2 });
  const audioMediaUrl = parseYouTubeHlsMasterAudioUrl(masterBuf.toString('utf8'), hlsManifestUrl);
  if (!audioMediaUrl) throw new Error('Không tìm thấy kênh âm thanh trong HLS Manifest.');

  const mediaBuf = await fetchBufferWithRetry(audioMediaUrl, { signal, maxAttempts: 2 });
  const parsedMedia = parseYouTubeHlsMediaPlaylist(mediaBuf.toString('utf8'), audioMediaUrl);
  if (!parsedMedia?.segments?.length) {
   throw new Error('Danh sách phân đoạn HLS YouTube trống.');
  }

  return {
   lenMs: lenMs || parsedMedia.totalDurationMs,
   initUrl: parsedMedia.initUrl,
   segments: parsedMedia.segments,
   usedPoToken: usePoToken,
  };
 }

 // Tầng 1 (Siêu tốc ~0.3s, 0 MB JSDOM, 0 tiến trình phụ): Phát trực tiếp phân đoạn AAC HLS itag/234 qua Apple visionOS + visitorData!
 async function openVisionOsHlsStream(videoId, { signal, track = null, seekMs = 0 } = {}) {
  let plan;
  try {
   plan = await resolveVisionOsHlsPlan(videoId, { signal, usePoToken: false });
  } catch (firstErr) {
   if (firstErr?.isPolicyBlock || signal?.aborted) throw firstErr;
   if (firstErr?.playabilityStatus === 'LOGIN_REQUIRED') {
    const hasCookie = Boolean(await readOptionalCookieRaw());
    if (hasCookie) throw firstErr;
   }
   // Nếu IP máy chủ bị hỏi xác thực bot và chưa gắn Cookie, tự kẹp thêm Session PoToken (visitorData) thử lại ngay!
   plan = await resolveVisionOsHlsPlan(videoId, { signal, usePoToken: true });
  }

  if (track && plan.lenMs > 0 && (!track.duration || Math.abs(Number(track.duration) - plan.lenMs) > 4000)) {
   track.duration = plan.lenMs;
   onTrackMetaSynced?.(track);
  }

  const clampedSeekMs = Math.max(
   0,
   plan.lenMs > 2000
    ? Math.min(Math.floor(Number(seekMs) || 0), plan.lenMs - 1500)
    : Math.floor(Number(seekMs) || 0),
  );

  let activeSegments = plan.segments;
  let activeInitUrl = plan.initUrl;
  let segCursor = findHlsSegmentStartIndex(activeSegments, clampedSeekMs);
  let initSent = !activeInitUrl;
  let refreshedOnce = false;

  // Tải sẵn phân đoạn đầu tiên ngay trong getStream() để xác thực 100% CDN trả HTTP 200 trước khi giao cho AudioPlayer!
  let prefetchedInitBuf = null;
  if (!initSent && activeInitUrl) {
   prefetchedInitBuf = await fetchBufferWithRetry(activeInitUrl, { signal, maxAttempts: 2 });
   initSent = true;
  }
  const firstSeg = activeSegments[segCursor];
  if (!firstSeg) throw new Error('Không tìm thấy phân đoạn bắt đầu hợp lệ.');
  let prefetchedFirstSegBuf = await fetchBufferWithRetry(firstSeg.url, { signal, maxAttempts: 2 });
  segCursor++;

  let pulling = false;
  let closed = false;

  const nodeStream = new Readable({
   highWaterMark: 64 * 1024,
   read() {
    if (pulling || closed) return;
    pulling = true;
    void (async () => {
     try {
      if (prefetchedInitBuf) {
       const b = prefetchedInitBuf;
       prefetchedInitBuf = null;
       if (!this.push(b)) return;
      }
      if (prefetchedFirstSegBuf) {
       const b = prefetchedFirstSegBuf;
       prefetchedFirstSegBuf = null;
       if (!this.push(b)) return;
      }

      while (!closed && !this.destroyed && segCursor < activeSegments.length) {
       if (signal?.aborted) {
        closed = true;
        this.push(null);
        return;
       }
       const seg = activeSegments[segCursor];
       let buf;
       try {
        buf = await fetchBufferWithRetry(seg.url, { signal, maxAttempts: 3 });
        refreshedOnce = false;
       } catch (segErr) {
        if ((segErr?.status === 401 || segErr?.status === 403) && !refreshedOnce && !signal?.aborted) {
         refreshedOnce = true;
         const freshPlan = await resolveVisionOsHlsPlan(videoId, {
          signal,
          usePoToken: plan.usedPoToken,
         });
         activeSegments = freshPlan.segments;
         segCursor = findHlsSegmentStartIndex(activeSegments, seg.startMs);
         continue;
        }
        throw segErr;
       }

       if (closed || this.destroyed) return;
       segCursor++;
       const keepReading = this.push(buf);
       if (!keepReading) break;
      }

      if (!closed && !this.destroyed && segCursor >= activeSegments.length) {
       closed = true;
       this.push(null);
      }
     } catch (err) {
      if (!closed && !this.destroyed) {
       closed = true;
       this.destroy(err instanceof Error ? err : new Error(String(err)));
      }
     } finally {
      pulling = false;
     }
    })();
   },
   destroy(err, callback) {
    closed = true;
    prefetchedInitBuf = null;
    prefetchedFirstSegBuf = null;
    callback(err);
   },
  });

  if (signal) {
   signal.addEventListener('abort', () => nodeStream.destroy(), { once: true });
  }

  return nodeStream;
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

 async function fetchSabrPlayerPayload(videoId, sessionPoToken, sts, clientCfg, visitorSession, signal) {
  const reqSignal = signal
   ? AbortSignal.any([signal, AbortSignal.timeout(10_000)])
   : AbortSignal.timeout(10_000);
  const clientVersion =
   clientCfg.useLiveWebVersion && visitorSession?.webClientVersion
    ? visitorSession.webClientVersion
    : clientCfg.version;
  const cookieRaw = await readOptionalCookieRaw();
  const cookieAuthHeaders = buildYouTubeCookieAuthHeaders(cookieRaw, clientCfg.origin);
  const isSignedIn = Boolean(cookieAuthHeaders.Authorization);
  const headers = {
   'Content-Type': 'application/json',
   'Origin': clientCfg.origin,
   'Referer': `${clientCfg.origin}/`,
   'X-YouTube-Client-Name': String(clientCfg.id),
   'X-YouTube-Client-Version': clientVersion,
   'User-Agent': CHROME_UA,
   ...cookieAuthHeaders,
  };
  if (!isSignedIn && visitorSession?.visitorData) {
   headers['X-Goog-Visitor-Id'] = visitorSession.visitorData;
  }

  const res = await fetchImpl(clientCfg.endpoint, {
   method: 'POST',
   signal: reqSignal,
   headers,
   body: JSON.stringify({
    videoId,
    context: {
     client: {
      clientName: clientCfg.name,
      clientVersion,
      ...(!isSignedIn && visitorSession?.visitorData ? { visitorData: visitorSession.visitorData } : {}),
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
    serviceIntegrityDimensions: { poToken: sessionPoToken },
    contentCheckOk: true,
    racyCheckOk: true,
   }),
  });
  if (!res.ok) throw new Error(`YouTube player HTTP ${res.status}`);
  return { data: await res.json(), clientVersion };
 }

 // Tầng 2 (Dự phòng SABR Opus 251 đầy đủ): Kẹp đồng thời visitorData + Session PoToken (/player) + Content PoToken (SabrStream)!
 async function openRawSabrStream(
  videoId,
  { signal, track = null, seekMs = 0, allowCipherRetry = true } = {},
 ) {
  const [cipher, visitorSession] = await Promise.all([
   ensureCipher({ forceRefresh: false }),
   ensureYouTubeVisitorSession({ fetchImpl }),
  ]);
  const [gvsPoToken, { SabrStream, buildSabrFormat, EnabledTrackTypes }] = await Promise.all([
   mintPoToken(videoId, signal),
   loadSabrModules(),
  ]);
  const sessionPoToken = visitorSession.visitorData
   ? await mintPoToken(visitorSession.visitorData, signal)
   : gvsPoToken;

  let chosenClient = null;
  let chosenVersion = '';
  let playerData = null;
  let lastReason = '';

  for (const clientCfg of SABR_CLIENTS) {
   try {
    const { data, clientVersion } = await fetchSabrPlayerPayload(
     videoId,
     sessionPoToken,
     cipher.sts,
     clientCfg,
     visitorSession,
     signal,
    );
    const status = data?.playabilityStatus?.status;
    const hasSabr = Boolean(
     data?.streamingData?.serverAbrStreamingUrl &&
      data?.streamingData?.adaptiveFormats?.length &&
      data?.playerConfig?.mediaCommonConfig?.mediaUstreamerRequestConfig?.videoPlaybackUstreamerConfig,
    );
    if (status === 'OK' && hasSabr) {
     chosenClient = clientCfg;
     chosenVersion = clientVersion;
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
   throw createPolicyBlockError('Chỉ nhận bài tối đa 180 phút, không nhận phát trực tiếp (livestream).');
  }
  const lenMs = (Number(vd.lengthSeconds) || 0) * 1000;
  if (lenMs > 10_800_000) {
   throw createPolicyBlockError('Chỉ nhận bài tối đa 180 phút, không nhận phát trực tiếp (livestream).');
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
   const serverAbrStreamingUrl = cipher.decipherUrl(
    playerData.streamingData.serverAbrStreamingUrl,
    '',
    chosenVersion,
   );
   const ustreamerConfig =
    playerData.playerConfig.mediaCommonConfig.mediaUstreamerRequestConfig.videoPlaybackUstreamerConfig;
   const formats = playerData.streamingData.adaptiveFormats.map(f =>
    mapRawFormatToSabr(buildSabrFormat, f),
   );

   sabr = new SabrStream({
    formats,
    serverAbrStreamingUrl,
    videoPlaybackUstreamerConfig: ustreamerConfig,
    poToken: gvsPoToken,
    clientInfo: { clientName: chosenClient.id, clientVersion: chosenVersion },
    durationMs: lenMs > 0 ? lenMs : undefined,
    fetch: fetchImpl,
   });

   // Khóa điều tiết áp lực ngược (Backpressure) trên SabrStream: chỉ tải trước tối đa ~384 KB (~24 giây âm thanh Opus)
   // rồi tự ngủ chờ FFmpeg đọc vơi xuống < 192 KB mới tải tiếp -> chặn đứng nạp dồn cả bài dài vào RAM hoặc vòng lặp vô tận!
   const SABR_HIGH_WATER_BYTES = 384 * 1024;
   const SABR_LOW_WATER_BYTES = 192 * 1024;
   const maxAllowedTrackBytes = Math.max(
    24 * 1024 * 1024,
    Math.ceil(((lenMs > 0 ? lenMs : 10_800_000) / 1000) * 48 * 1024),
   );
   let queuedAheadBytes = 0;
   let totalDeliveredBytes = 0;
   let drainWaiter = null;
   let cleanedUp = false;

   const wakeDrainWaiter = () => {
    if (drainWaiter) {
     const resolve = drainWaiter;
     drainWaiter = null;
     resolve();
    }
   };

   if (sabr.audioController && typeof sabr.audioController.enqueue === 'function') {
    const origEnqueue = sabr.audioController.enqueue.bind(sabr.audioController);
    sabr.audioController.enqueue = chunk => {
     const sz = chunk?.byteLength ?? chunk?.length ?? 0;
     queuedAheadBytes += sz;
     totalDeliveredBytes += sz;
     if (totalDeliveredBytes > maxAllowedTrackBytes) {
      throw new Error('SABR vượt ngưỡng dữ liệu an toàn của bài hát.');
     }
     return origEnqueue(chunk);
    };
   }

   if (typeof sabr.fetchAndProcessSegments === 'function') {
    const origFetchSegments = sabr.fetchAndProcessSegments.bind(sabr);
    sabr.fetchAndProcessSegments = async function throttledFetchSegments(...args) {
     while (
      queuedAheadBytes >= SABR_HIGH_WATER_BYTES &&
      !cleanedUp &&
      !sabr._aborted &&
      !signal?.aborted
     ) {
      await new Promise(resolve => {
       drainWaiter = resolve;
      });
     }
     if (cleanedUp || sabr._aborted || signal?.aborted) return;
     return origFetchSegments(...args);
    };
   }

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
     const [freshCipher, freshVisitor, refreshedGvsPo] = await Promise.all([
      ensureCipher({ forceRefresh: false }),
      ensureYouTubeVisitorSession({ fetchImpl }),
      mintPoToken(videoId, signal),
     ]);
     const refreshedSessionPo = freshVisitor.visitorData
      ? await mintPoToken(freshVisitor.visitorData, signal)
      : refreshedGvsPo;
     const { data: reloaded, clientVersion: nextVer } = await fetchSabrPlayerPayload(
      videoId,
      refreshedSessionPo,
      freshCipher.sts,
      chosenClient,
      freshVisitor,
      signal,
     );
     const nextUrlRaw = reloaded?.streamingData?.serverAbrStreamingUrl;
     const nextCfg =
      reloaded?.playerConfig?.mediaCommonConfig?.mediaUstreamerRequestConfig?.videoPlaybackUstreamerConfig;
     const nextFormats = (reloaded?.streamingData?.adaptiveFormats ?? []).map(f =>
      mapRawFormatToSabr(buildSabrFormat, f),
     );
     sabr?.setPoToken(refreshedGvsPo);
     if (nextUrlRaw) sabr?.setStreamingURL(freshCipher.decipherUrl(nextUrlRaw, '', nextVer));
     if (nextCfg) sabr?.setUstreamerConfig(nextCfg);
     if (nextFormats.length && sabr) {
      sabr.formatIds = [];
      sabr.setServerAbrFormats(nextFormats);
     }
    } catch {}
   };

   sabr.on('reloadPlayerResponse', reloadHandler);

   for (const ctrl of [sabr.videoController, sabr.audioController]) {
    if (!ctrl) continue;
    if (typeof ctrl.close === 'function') {
     const origClose = ctrl.close.bind(ctrl);
     ctrl.close = () => {
      try {
       origClose();
      } catch {}
     };
    }
    if (typeof ctrl.error === 'function') {
     const origError = ctrl.error.bind(ctrl);
     ctrl.error = errArg => {
      try {
       origError(errArg);
      } catch {}
     };
    }
   }

   const started = await sabr.start({
    enabledTrackTypes: EnabledTrackTypes.AUDIO_ONLY,
    audioQuality: 'medium',
    preferWebM: true,
    preferOpus: true,
   });
   if (!started?.audioStream) {
    throw new Error('SABR không trả về luồng âm thanh.');
   }

   const reader = started.audioStream.getReader();
   const sabrRef = sabr;
   let pulling = false;

   const teardown = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    wakeDrainWaiter();
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
         queuedAheadBytes = Math.max(0, queuedAheadBytes - value.byteLength);
         if (queuedAheadBytes <= SABR_LOW_WATER_BYTES) {
          wakeDrainWaiter();
         }
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
   if (allowCipherRetry && !err?.isPolicyBlock && !signal?.aborted) {
    await ensureCipher({ forceRefresh: true }).catch(() => {});
    return openRawSabrStream(videoId, { signal, track, seekMs, allowCipherRetry: false });
   }
   throw err;
  }
 }

 let streamSetupChain = Promise.resolve();
 function withSingleFlightStreamSetup(fn) {
  const next = streamSetupChain.then(fn, fn);
  streamSetupChain = next.then(
   () => undefined,
   () => undefined,
  );
  return next;
 }

 async function openYouTubeAudioStream(videoId, { signal, track = null, seekMs = 0 } = {}) {
  return withSingleFlightStreamSetup(async () => {
   if (signal?.aborted) throw new Error('Đã hủy tải luồng YouTube.');
   try {
    return await openVisionOsHlsStream(videoId, { signal, track, seekMs });
   } catch (hlsErr) {
    if (hlsErr?.isPolicyBlock || signal?.aborted) throw hlsErr;
    return openRawSabrStream(videoId, { signal, track, seekMs });
   }
  });
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
  version: '2.1.0',
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
    const items = await searchYouTubeVideos(trimmed, { limit: 10, fetchImpl, signal });
    return { tracks: items.map(it => buildYouTubeTrack(it, requestedBy)) };
   }

   if (!trimmed.startsWith('https://')) {
    return { tracks: [] };
   }

   let playlistId = null;
   let videoId = null;
   let startIndex = null;
   try {
    playlistId = extractYouTubePlaylistId(trimmed);
    videoId = extractYouTubeVideoId(trimmed);
    const u = new URL(trimmed);
    const rawIdx = Number.parseInt(u.searchParams.get('index') ?? '', 10);
    if (Number.isInteger(rawIdx) && rawIdx >= 1) startIndex = rawIdx - 1;
   } catch {
    return { tracks: [] };
   }
   if (!playlistId && !videoId) return { tracks: [] };

   if (playlistId) {
    const col = await resolveYouTubeCollection({ playlistId, videoId, startIndex, fetchImpl });
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
   const meta = await resolveSingleYouTubeMeta(videoId, fetchImpl);
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
   const stream = await openYouTubeAudioStream(videoId, { signal, track, seekMs: 0 });
   return {
    stream,
    type: 'arbitrary',
    recreate: positionMs => openYouTubeAudioStream(videoId, { track, seekMs: positionMs }),
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
     fetchImpl,
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
