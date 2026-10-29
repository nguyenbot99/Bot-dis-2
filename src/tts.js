import { Readable } from 'node:stream';
import {
 AudioPlayerStatus,
 createAudioPlayer,
 createAudioResource,
 getVoiceConnection,
 NoSubscriberBehavior,
 StreamType,
} from '@discordjs/voice';

export const MAX_TTS_TEXT_LENGTH = 500;
export const MAX_TTS_CHUNK_LENGTH = 185;
export const MAX_TTS_QUEUE_PER_GUILD = 5;

export const TTS_LANGUAGES = Object.freeze({
 vi: { code: 'vi', label: '🇻🇳 Tiếng Việt (Chị Google)' },
 en: { code: 'en', label: '🇺🇸 Tiếng Anh (English)' },
 ja: { code: 'ja', label: '🇯🇵 Tiếng Nhật (日本語)' },
 ko: { code: 'ko', label: '🇰🇷 Tiếng Hàn (한국어)' },
 'zh-CN': { code: 'zh-CN', label: '🇨🇳 Tiếng Trung (中文)' },
 fr: { code: 'fr', label: '🇫🇷 Tiếng Pháp (Français)' },
 th: { code: 'th', label: '🇹🇭 Tiếng Thái (ไทย)' },
});

// Các chế độ biến hình giọng đọc /tts thời gian thực bằng DSP (0 MB RAM phát sinh).
export const TTS_VOICES = Object.freeze({
 normal: {
  id: 'normal',
  label: '👩 Chị Google Chuẩn',
  presetKey: 'vocal',
  rate: 1.0,
  echo: false,
  volume: 1.35,
 },
 loaphuong: {
  id: 'loaphuong',
  label: '📻 Loa Phường Đầu Ngõ',
  presetKey: 'loaphuong',
  rate: 1.03,
  echo: false,
  volume: 1.48,
 },
 minion: {
  id: 'minion',
  label: '🐿️ Minion Nhí Nhố',
  presetKey: 'vocal',
  rate: 1.34,
  echo: false,
  volume: 1.38,
 },
 boss: {
  id: 'boss',
  label: '👹 Boss Cuối Trầm Ngầu',
  presetKey: 'bass',
  rate: 0.78,
  echo: true,
  volume: 1.48,
 },
 cave: {
  id: 'cave',
  label: '🕳️ Vang Vọng Hang Động',
  presetKey: 'vocal',
  rate: 0.96,
  echo: true,
  volume: 1.4,
 },
});

const GOOGLE_TTS_UA =
 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// Làm sạch văn bản Discord (emoji tùy chỉnh, tag thành viên/kênh/role, đường dẫn dài) trước khi đưa cho chị Google đọc.
export function sanitizeTtsText(
 rawText,
 {
  resolveUserName = null,
  resolveChannelName = null,
  resolveRoleName = null,
 } = {},
) {
 if (typeof rawText !== 'string') {
  throw new Error('Nội dung đọc không được để trống.');
 }

 let cleaned = rawText
  // Thay tag người dùng <@123> hoặc <@!123>
  .replace(/<@!?(\d{15,22})>/g, (_, id) => {
   const name = typeof resolveUserName === 'function' ? resolveUserName(id) : null;
   return name ? ` ${name} ` : ' bạn đó ';
  })
  // Thay tag kênh <#123>
  .replace(/<#(\d{15,22})>/g, (_, id) => {
   const name = typeof resolveChannelName === 'function' ? resolveChannelName(id) : null;
   return name ? ` kênh ${name} ` : ' kênh này ';
  })
  // Thay tag vai trò <@&123>
  .replace(/<@&(\d{15,22})>/g, (_, id) => {
   const name = typeof resolveRoleName === 'function' ? resolveRoleName(id) : null;
   return name ? ` ${name} ` : ' mọi người ';
  })
  // Đọc tên emoji tùy chỉnh thay vì đọc dãy số ID dài
  .replace(/<a?:([a-zA-Z0-9_]{1,40}):\d{15,22}>/g, (_, name) => ` ${name.replace(/_/g, ' ')} `)
  // Tránh đánh vần cả đường link dài lê thê
  .replace(/https?:\/\/\S+/gi, ' đường dẫn ')
  // Xóa ký tự điều khiển ẩn
  .replace(/[\u0000-\u001F\u007F]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

 if (!cleaned) {
  throw new Error('Nội dung đọc không được để trống.');
 }
 if (cleaned.length > MAX_TTS_TEXT_LENGTH) {
  cleaned = cleaned.slice(0, MAX_TTS_TEXT_LENGTH).trim();
 }
 return cleaned;
}

// Tách câu dài thành từng đoạn ngắn <= 185 ký tự tại dấu câu / khoảng trắng để Google TTS đọc liền mạch không bị cắt chữ.
export function splitTtsChunks(text, maxLen = MAX_TTS_CHUNK_LENGTH) {
 const input = String(text ?? '').trim();
 if (!input) return [];
 if (input.length <= maxLen) return [input];

 const chunks = [];
 let remaining = input;

 while (remaining.length > maxLen) {
  const windowStr = remaining.slice(0, maxLen + 1);
  let cut = -1;

  // Ưu tiên ngắt ở dấu kết câu (. ! ? ;), sau đó dấu phẩy (, : -), rồi tới khoảng trắng.
  for (const re of [/[.!?;]\s/g, /[,:\-–]\s/g, /\s/g]) {
   let m;
   while ((m = re.exec(windowStr)) !== null) {
    if (m.index >= Math.floor(maxLen * 0.35)) {
     cut = m.index + 1;
    }
   }
   if (cut > 0) break;
  }

  if (cut <= 0) cut = maxLen;
  const piece = remaining.slice(0, cut).trim();
  if (piece) chunks.push(piece);
  remaining = remaining.slice(cut).trim();
 }

 if (remaining) chunks.push(remaining);
 return chunks.slice(0, 6);
}

// Tải âm thanh MP3 giọng chị Google siêu nhẹ (~20-50 KB, không cần thư viện ngoài, giải phóng RAM ngay sau khi đọc).
export async function synthesizeGoogleTtsBuffer(
 rawText,
 {
  lang = 'vi',
  slow = false,
  fetchImpl = fetch,
  sanitizeOptions = {},
 } = {},
) {
 const safeLang = TTS_LANGUAGES[lang] ? lang : 'vi';
 const cleanText = sanitizeTtsText(rawText, sanitizeOptions);
 const chunks = splitTtsChunks(cleanText);
 if (!chunks.length) {
  throw new Error('Nội dung đọc không hợp lệ.');
 }

 const buffers = await Promise.all(
  chunks.map(async (chunk, idx) => {
   const params = new URLSearchParams({
    ie: 'UTF-8',
    q: chunk,
    tl: safeLang,
    total: String(chunks.length),
    idx: String(idx),
    textlen: String(chunk.length),
    client: 'tw-ob',
    ttsspeed: slow ? '0.24' : '1',
   });
   const url = `https://translate.google.com/translate_tts?${params.toString()}`;
   const res = await fetchImpl(url, {
    headers: {
     'User-Agent': GOOGLE_TTS_UA,
     Referer: 'https://translate.google.com/',
    },
    signal: AbortSignal.timeout(8000),
   });
   if (!res?.ok) {
    throw new Error(`Không lấy được giọng đọc Google TTS (HTTP ${res?.status ?? 'ERR'}).`);
   }
   const arr = await res.arrayBuffer();
   const buf = Buffer.from(arr);
   if (buf.length < 64) {
    throw new Error('Không nhận được dữ liệu âm thanh hợp lệ từ Google TTS.');
   }
   return buf;
  }),
 );

 return {
  buffer: Buffer.concat(buffers),
  cleanText,
  lang: safeLang,
  langLabel: TTS_LANGUAGES[safeLang].label,
 };
}

// Bộ điều phối đọc TTS trong kênh thoại: tự động tạm dừng nhạc đang phát -> đọc xong -> phát tiếp nhạc đúng giây vừa dừng.
export function createGuildTtsController({
 getVoiceConnectionFn = getVoiceConnection,
 createAudioPlayerFn = createAudioPlayer,
 createAudioResourceFn = createAudioResource,
 onIdleAfterTts = null,
 chunkTimeoutMs = 22_000,
} = {}) {
 const guildStates = new Map();

 function getOrCreateState(guildId) {
  let state = guildStates.get(guildId);
  if (!state) {
   const ttsPlayer = createAudioPlayerFn({
    behaviors: { noSubscriber: NoSubscriberBehavior.Stop },
   });
   state = {
    guildId,
    ttsPlayer,
    queue: [],
    speaking: false,
    pausedMusicForTts: false,
    cancelled: false,
   };
   guildStates.set(guildId, state);
  }
  return state;
 }

 function resolveConnection(guildId, player) {
  const connCtrl = player?.runtimeGraph?.connectionController;
  if (connCtrl?.connection && connCtrl.connection.state?.status !== 'destroyed') {
   return connCtrl.connection;
  }
  const group = connCtrl?.group;
  const conn = group ? getVoiceConnectionFn(guildId, group) : getVoiceConnectionFn(guildId);
  if (conn && conn.state?.status !== 'destroyed') return conn;
  return null;
 }

 function playSingleBuffer(ttsPlayer, item, state) {
  const mp3Buffer = Buffer.isBuffer(item) ? item : item?.buffer;
  const presetKey = (!Buffer.isBuffer(item) && item?.presetKey) || 'vocal';
  const volLevel = (!Buffer.isBuffer(item) && typeof item?.volume === 'number') ? item.volume : 1.35;
  const rate = (!Buffer.isBuffer(item) && Number(item?.rate) > 0) ? Number(item.rate) : 1.0;
  const echo = Boolean(!Buffer.isBuffer(item) && item?.echo);
  return new Promise(resolve => {
   if (state.cancelled) return resolve();
   let settled = false;
   let timer = null;

   const finish = () => {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    ttsPlayer.removeListener(AudioPlayerStatus.Idle, onIdle);
    ttsPlayer.removeListener('stateChange', onStateChange);
    ttsPlayer.removeListener('error', onError);
    resolve();
   };

   const onIdle = () => finish();
   const onStateChange = (oldS, newS) => {
    if (oldS?.status !== AudioPlayerStatus.Idle && newS?.status === AudioPlayerStatus.Idle) {
     finish();
    }
   };
   const onError = () => finish();

   timer = setTimeout(() => {
    try { ttsPlayer.stop(true); } catch {}
    finish();
   }, chunkTimeoutMs);
   timer.unref?.();

   ttsPlayer.once(AudioPlayerStatus.Idle, onIdle);
   ttsPlayer.on('stateChange', onStateChange);
   ttsPlayer.once('error', onError);

   try {
    const resource = createAudioResourceFn(Readable.from([mp3Buffer]), {
     inputType: StreamType.Arbitrary,
     inlineVolume: true,
    });
    if (resource?.volume) {
     resource.volume._forcePresetKey = presetKey;
     resource.volume._forceRate = rate;
     resource.volume._forceEcho = echo;
     if (typeof resource.volume.setVolume === 'function') {
      resource.volume.setVolume(volLevel);
     }
    }
    ttsPlayer.play(resource);
   } catch {
    finish();
   }
  });
 }

 async function drainQueue(state, getLatestPlayer) {
  if (state.speaking) return;
  state.speaking = true;
  state.cancelled = false;

  const initialPlayer = getLatestPlayer();
  const initialConn = resolveConnection(state.guildId, initialPlayer);
  if (!initialConn) {
   state.queue.length = 0;
   state.speaking = false;
   throw new Error('Bot chưa kết nối xong vào phòng thoại, vui lòng thử lại.');
  }

  const hasTrack = Boolean(initialPlayer?.queue?.currentTrack || initialPlayer?.currentTrack);
  const wasMusicPlaying = Boolean(
   initialPlayer &&
    !initialPlayer.destroyed &&
    hasTrack &&
    !initialPlayer.isPaused &&
    !initialPlayer.userdata?.voiceMuted,
  );

  if (wasMusicPlaying) {
   state.pausedMusicForTts = true;
   if (initialPlayer.userdata) initialPlayer.userdata.autoPausedByTts = true;
   try { initialPlayer.pause(); } catch {}
  }

  try {
   initialConn.subscribe(state.ttsPlayer);

   while (state.queue.length > 0 && !state.cancelled) {
    const nextBuf = state.queue.shift();
    const curConn = resolveConnection(state.guildId, getLatestPlayer());
    if (!curConn) break;
    curConn.subscribe(state.ttsPlayer);
    await playSingleBuffer(state.ttsPlayer, nextBuf, state);
   }
  } finally {
   const finalPlayer = getLatestPlayer();
   const finalConn = resolveConnection(state.guildId, finalPlayer);

   // Trả lại đường truyền âm thanh cho trình phát nhạc ZiPlayer
   if (finalConn && finalPlayer && !finalPlayer.destroyed) {
    const connCtrl = finalPlayer.runtimeGraph?.connectionController;
    if (typeof connCtrl?.ensureSubscription === 'function') {
     connCtrl.ensureSubscription(finalConn);
    } else if (finalPlayer.audioPlayer) {
     try { finalConn.subscribe(finalPlayer.audioPlayer); } catch {}
    }
   }

   // Nếu trước khi đọc TTS nhạc đang phát và người dùng chưa chủ động bấm Tạm dừng / Dừng thì phát nhạc tiếp ngay đúng giây đó
   const shouldResumeMusic = Boolean(
    state.pausedMusicForTts &&
     !state.cancelled &&
     finalPlayer &&
     !finalPlayer.destroyed &&
     finalPlayer.userdata?.autoPausedByTts !== false &&
     finalPlayer.isPaused &&
     !finalPlayer.userdata?.voiceMuted &&
     (finalPlayer.queue?.currentTrack || finalPlayer.currentTrack),
   );

   state.pausedMusicForTts = false;
   state.speaking = false;
   if (finalPlayer?.userdata) {
    finalPlayer.userdata.autoPausedByTts = false;
   }

   if (shouldResumeMusic) {
    try { finalPlayer.resume(); } catch {}
   } else if (finalPlayer && !finalPlayer.destroyed) {
    const stillHasTrack = Boolean(finalPlayer.queue?.currentTrack || finalPlayer.currentTrack);
    if (!stillHasTrack) {
     onIdleAfterTts?.(state.guildId, finalPlayer);
    }
   }
  }
 }

 async function enqueueSpeech({
  guildId,
  player,
  getPlayer,
  mp3Buffer,
  voiceStyle = null,
  presetKey = null,
  volume = null,
  rate = null,
  echo = null,
 }) {
  const voiceDef = voiceStyle && TTS_VOICES[voiceStyle] ? TTS_VOICES[voiceStyle] : null;
  const resolvedPreset = presetKey ?? voiceDef?.presetKey ?? 'vocal';
  const resolvedVolume = volume ?? voiceDef?.volume ?? 1.35;
  const resolvedRate = rate ?? voiceDef?.rate ?? 1.0;
  const resolvedEcho = echo ?? voiceDef?.echo ?? false;

  const state = getOrCreateState(guildId);
  if (state.queue.length >= MAX_TTS_QUEUE_PER_GUILD) {
   throw new Error('Hàng chờ âm thanh thoại đang đầy (tối đa 5 lượt liên tiếp), vui lòng chờ vài giây.');
  }
  const resolvePlayer = typeof getPlayer === 'function' ? getPlayer : () => player;
  if (!resolveConnection(guildId, resolvePlayer())) {
   throw new Error('Bot chưa kết nối xong vào phòng thoại, vui lòng thử lại.');
  }

  const wasAlreadySpeaking = state.speaking;
  state.queue.push({
   buffer: mp3Buffer,
   presetKey: resolvedPreset,
   volume: resolvedVolume,
   rate: resolvedRate,
   echo: resolvedEcho,
  });
  if (!wasAlreadySpeaking) {
   void drainQueue(state, resolvePlayer).catch(() => {});
  }
  return { queued: wasAlreadySpeaking, position: state.queue.length };
 }

 function cancelGuild(guildId) {
  const state = guildStates.get(guildId);
  if (!state) return;
  state.cancelled = true;
  state.queue.length = 0;
  state.pausedMusicForTts = false;
  try { state.ttsPlayer.stop(true); } catch {}
 }

 function isSpeaking(guildId) {
  return Boolean(guildStates.get(guildId)?.speaking);
 }

 return {
  enqueueSpeech,
  cancelGuild,
  isSpeaking,
 };
}
