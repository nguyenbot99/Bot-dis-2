// Mô-đun tra cứu lời bài hát & Karaoke chạy chữ theo ca sĩ (hỗ trợ mốc thời gian [mm:ss.xx] từ LRCLIB, siêu nhẹ, có bộ đệm LRU nhỏ gọn).

const webLyricsCache = new Map();
const MAX_LYRICS_CACHE = 20;

export function sanitizeLyricsTitle(rawTitle = '', rawArtist = '') {
 let artist = String(rawArtist ?? '').replace(/\s*-\s*Topic$/i, '').trim();
 let title = String(rawTitle ?? '').trim();

 if (!artist && /\s[-–—]\s/.test(title)) {
  const [maybeArtist, ...rest] = title.split(/\s[-–—]\s/);
  if (maybeArtist && rest.length) {
   artist = maybeArtist.trim();
   title = rest.join(' - ').trim();
  }
 }

 title = title
  .replace(/\s*[\[(][^\]\)]*[\])]\s*/g, ' ')
  .replace(/\b(official\s+music\s+video|official\s+video|official\s+audio|lyric\s*video|lyrics?|visualizer|audio|mv|hd|4k|full|remix)\b/gi, ' ')
  .replace(/\b(ft\.?|feat\.?|prod\.?)\s+[^-–|]+/gi, ' ')
  .replace(/[|•·~]+/g, ' ')
  .replace(/\s{2,}/g, ' ')
  .trim();

 return { title: title || String(rawTitle ?? '').trim(), artist };
}

// Giải mã định dạng LRC [mm:ss.xx] sang mảng câu Karaoke kèm mốc mili-giây chính xác.
export function parseSyncedLyrics(rawLrc = '') {
 if (typeof rawLrc !== 'string' || !rawLrc.trim()) return [];
 const entries = [];
 const lineRe = /\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/g;

 for (const rawLine of rawLrc.split(/\r?\n/)) {
  const stamps = [];
  let m;
  lineRe.lastIndex = 0;
  while ((m = lineRe.exec(rawLine)) !== null) {
   const mins = Number.parseInt(m[1], 10);
   const secs = Number.parseInt(m[2], 10);
   const fracStr = m[3] ? m[3].padEnd(3, '0').slice(0, 3) : '0';
   const ms = mins * 60_000 + secs * 1000 + Number.parseInt(fracStr, 10);
   if (Number.isFinite(ms) && ms >= 0) stamps.push(ms);
  }
  if (!stamps.length) continue;
  const text = rawLine.replace(/\[\d{1,2}:\d{2}(?:[.:]\d{1,3})?\]/g, '').trim();
  if (!text) continue;
  for (const t of stamps) {
   entries.push({ t, text: text.slice(0, 160) });
  }
 }

 entries.sort((a, b) => a.t - b.t);
 return entries.slice(0, 160);
}

export async function fetchTrackLyrics({ title: rawTitle, artist: rawArtist, durationMs }, fetchImpl = fetch) {
 const { title, artist } = sanitizeLyricsTitle(rawTitle, rawArtist);
 if (!title) throw new Error('Không xác định được tên bài hát để tìm lời.');

 const headers = { 'User-Agent': 'ZiLightMusicBot/1.0 (https://github.com/ZiProject/ZiPlayer)' };
 const tryJson = async url => {
  const res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(6500) });
  if (!res.ok) return null;
  return res.json();
 };

 // 1. Tìm chính xác hoặc gần đúng trên LRCLIB (ưu tiên bản có syncedLyrics chạy chữ Karaoke).
 const params = new URLSearchParams({ track_name: title });
 if (artist && artist !== 'Không rõ' && artist !== 'Nghệ sĩ') params.set('artist_name', artist);
 if (Number.isFinite(durationMs) && durationMs > 0) params.set('duration', String(Math.round(durationMs / 1000)));

 let items = await tryJson(`https://lrclib.net/api/search?${params.toString()}`).catch(() => null);
 if (!Array.isArray(items) || !items.length) {
  const q = [artist && artist !== 'Không rõ' ? artist : '', title].filter(Boolean).join(' ').trim();
  items = await tryJson(`https://lrclib.net/api/search?q=${encodeURIComponent(q)}`).catch(() => null);
 }

 if (Array.isArray(items) && items.length) {
  const match =
   items.find(it => typeof it?.syncedLyrics === 'string' && it.syncedLyrics.trim()) ??
   items.find(it => typeof it?.plainLyrics === 'string' && it.plainLyrics.trim());
  if (match) {
   const synced = parseSyncedLyrics(match.syncedLyrics ?? '');
   const plain =
    match.plainLyrics?.trim() ||
    (match.syncedLyrics ? match.syncedLyrics.replace(/\[\d{1,2}:\d{2}(?:[.:]\d{1,3})?\]/g, '').trim() : '');
   if (plain || synced.length > 0) {
    return {
     title: match.trackName || title,
     artist: match.artistName || artist || 'Không rõ',
     source: 'LRCLIB',
     text: plain || synced.map(s => s.text).join('\n'),
     synced,
    };
   }
  }
 }

 // 2. Dự phòng sang Lyrics.ovh nếu có tên nghệ sĩ.
 if (artist && artist !== 'Không rõ') {
  const ovh = await tryJson(`https://api.lyrics.ovh/v1/${encodeURIComponent(artist)}/${encodeURIComponent(title)}`).catch(() => null);
  if (typeof ovh?.lyrics === 'string' && ovh.lyrics.trim()) {
   return {
    title,
    artist,
    source: 'Lyrics.ovh',
    text: ovh.lyrics.replace(/\r\n/g, '\n').trim(),
    synced: [],
   };
  }
 }

 throw new Error('Không tìm thấy lời cho bài hát này (thử gõ `/lyrics query: Tên bài - Ca sĩ`).');
}

// Tra cứu lời Karaoke cho Website Now Playing (có bộ đệm 20 bài để không gọi lặp lại API, tự trả về null nhẹ nhàng nếu bài không có lời).
export async function fetchWebKaraokeLyrics(track, fetchImpl = fetch) {
 if (!track?.title) return null;
 const rawDur = Number(track.duration ?? 0);
 const durationMs = rawDur > 0 ? (rawDur > 1000 ? rawDur : rawDur * 1000) : 0;
 const cacheKey = `${String(track.url || track.title).toLowerCase()}::${Math.round(durationMs / 1000)}`;
 if (webLyricsCache.has(cacheKey)) return webLyricsCache.get(cacheKey);

 try {
  const data = await fetchTrackLyrics(
   {
    title: track.title,
    artist: track.metadata?.author,
    durationMs,
   },
   fetchImpl,
  );
  const compact = {
   source: data.source,
   synced: Array.isArray(data.synced) ? data.synced.slice(0, 160) : [],
   plain: data.synced?.length ? '' : String(data.text || '').slice(0, 3500),
  };
  if (webLyricsCache.size >= MAX_LYRICS_CACHE) {
   const oldest = webLyricsCache.keys().next().value;
   if (oldest) webLyricsCache.delete(oldest);
  }
  webLyricsCache.set(cacheKey, compact);
  return compact;
 } catch {
  return null;
 }
}
