// Mô-đun tra cứu lời bài hát theo yêu cầu (chuyển thể gọn nhẹ từ lyricsExt của ZiPlayer, không chạy ngầm để tiết kiệm 100% RAM).

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

export async function fetchTrackLyrics({ title: rawTitle, artist: rawArtist, durationMs }, fetchImpl = fetch) {
 const { title, artist } = sanitizeLyricsTitle(rawTitle, rawArtist);
 if (!title) throw new Error('Không xác định được tên bài hát để tìm lời.');

 const headers = { 'User-Agent': 'ZiLightMusicBot/1.0 (https://github.com/ZiProject/ZiPlayer)' };
 const tryJson = async url => {
  const res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(6500) });
  if (!res.ok) return null;
  return res.json();
 };

 // 1. Tìm chính xác hoặc gần đúng trên LRCLIB (nguồn mặc định của ZiPlayer).
 const params = new URLSearchParams({ track_name: title });
 if (artist && artist !== 'Không rõ' && artist !== 'Nghệ sĩ') params.set('artist_name', artist);
 if (Number.isFinite(durationMs) && durationMs > 0) params.set('duration', String(Math.round(durationMs / 1000)));

 let items = await tryJson(`https://lrclib.net/api/search?${params.toString()}`).catch(() => null);
 if (!Array.isArray(items) || !items.length) {
  const q = [artist && artist !== 'Không rõ' ? artist : '', title].filter(Boolean).join(' ').trim();
  items = await tryJson(`https://lrclib.net/api/search?q=${encodeURIComponent(q)}`).catch(() => null);
 }

 if (Array.isArray(items) && items.length) {
  const match = items.find(it => typeof it?.plainLyrics === 'string' && it.plainLyrics.trim())
   ?? items.find(it => typeof it?.syncedLyrics === 'string' && it.syncedLyrics.trim());
  if (match) {
   const plain = match.plainLyrics?.trim()
    || match.syncedLyrics.replace(/\[\d{1,2}:\d{2}(?:\.\d{1,3})?\]/g, '').trim();
   if (plain) {
    return {
     title: match.trackName || title,
     artist: match.artistName || artist || 'Không rõ',
     source: 'LRCLIB',
     text: plain,
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
   };
  }
 }

 throw new Error('Không tìm thấy lời cho bài hát này (thử gõ `/lyrics query: Tên bài - Ca sĩ`).');
}
