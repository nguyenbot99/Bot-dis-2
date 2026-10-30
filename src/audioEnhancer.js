import { createRequire } from 'node:module';

export const MIN_VOLUME_PERCENT = 0;
export const MAX_VOLUME_PERCENT = 200;
const DSP_SAMPLE_RATE = 48000;
const STEREO_BYTES = 4; // 16-bit signed LE * 2 kênh (Trái + Phải)
const OPUS_FRAME_BYTES = 3840; // 960 mẫu stereo = 20ms mỗi khung Opus
const LOW_LATENCY_PCM_HWM = 7680; // Tối đa 40ms PCM nằm chờ sau bộ DSP để đổi âm lượng/chất âm ăn ngay lập tức (< 80ms)
const LOW_LATENCY_OPUS_HWM = 4; // Tối đa 4 gói Opus (80ms) đệm đầu ra

// Các cấu hình chất âm Studio xử lý trực tiếp theo thời gian thực (biquad 64-bit + mở rộng âm hình Mid/Side)
// kết hợp lấy mẫu chuẩn SoX 24-bit trong FFmpeg: đổi chất âm ăn ngay giữa bài trong ~80ms, không ngắt nhạc, không tốn thêm tiến trình.
export const SOUND_PRESETS = {
 hd: {
  label: 'Rõ nét HD',
  description: 'Lấy mẫu SoX 24-bit, âm hình 3D rộng, dải cao sáng trong & trầm gọn chắc',
  filter: 'aresample=48000:resampler=soxr:precision=24',
  preGainDb: -2.2,
  makeupGainDb: 1.8,
  stereoWidth: 1.24,
  stages: [
   { type: 'highpass', freq: 30, q: 0.707, gainDb: 0 },
   { type: 'lowshelf', freq: 95, q: 0.75, gainDb: 4.5 },
   { type: 'peaking', freq: 280, q: 1.15, gainDb: -3.0 },
   { type: 'peaking', freq: 3800, q: 1.0, gainDb: 4.0 },
   { type: 'highshelf', freq: 9200, q: 0.707, gainDb: 5.5 },
  ],
 },
 vocal: {
  label: 'Rõ lời & Sáng tiếng',
  description: 'Tôn giọng ca sĩ nổi bật phía trước, giảm dải trầm lấn lời hát',
  filter: 'aresample=48000:resampler=soxr:precision=24',
  preGainDb: -2.0,
  makeupGainDb: 2.2,
  stereoWidth: 0.90,
  stages: [
   { type: 'highpass', freq: 115, q: 0.707, gainDb: 0 },
   { type: 'lowshelf', freq: 170, q: 0.75, gainDb: -6.0 },
   { type: 'peaking', freq: 310, q: 1.2, gainDb: -3.2 },
   { type: 'peaking', freq: 1650, q: 0.95, gainDb: 4.5 },
   { type: 'peaking', freq: 3600, q: 1.0, gainDb: 5.8 },
   { type: 'highshelf', freq: 8500, q: 0.707, gainDb: 3.5 },
  ],
 },
 bass: {
  label: 'Bass Ấm & Căng',
  description: 'Tăng mạnh lực sub-bass & trống trầm đập chắc ngực, chống vỡ tiếng',
  filter: 'aresample=48000:resampler=soxr:precision=24',
  preGainDb: -4.8,
  makeupGainDb: 2.4,
  stereoWidth: 1.08,
  stages: [
   { type: 'highpass', freq: 26, q: 0.707, gainDb: 0 },
   { type: 'lowshelf', freq: 85, q: 0.72, gainDb: 9.5 },
   { type: 'peaking', freq: 64, q: 1.15, gainDb: 4.2 },
   { type: 'peaking', freq: 270, q: 1.15, gainDb: -3.8 },
   { type: 'peaking', freq: 3400, q: 1.1, gainDb: 1.8 },
   { type: 'highshelf', freq: 7500, q: 0.707, gainDb: -1.5 },
  ],
 },
 '8d': {
  label: '8D Xoay Vòng 360°',
  description: 'Âm thanh vòm xoay quanh đầu 360° cực chill khi đeo tai nghe',
  filter: 'aresample=48000:resampler=soxr:precision=24',
  preGainDb: -3.0,
  makeupGainDb: 2.1,
  stereoWidth: 1.16,
  orbitHz: 0.11,
  stages: [
   { type: 'highpass', freq: 30, q: 0.707, gainDb: 0 },
   { type: 'lowshelf', freq: 92, q: 0.75, gainDb: 4.6 },
   { type: 'peaking', freq: 290, q: 1.15, gainDb: -2.6 },
   { type: 'peaking', freq: 3500, q: 1.0, gainDb: 2.8 },
   { type: 'highshelf', freq: 9000, q: 0.707, gainDb: 4.2 },
  ],
 },
 flat: {
  label: 'Nguyên bản',
  description: 'Giữ nguyên EQ gốc tự nhiên 100%, chỉ lấy mẫu SoX 24-bit & chống rè tiếng',
  filter: 'aresample=48000:resampler=soxr:precision=24',
  preGainDb: 0,
  makeupGainDb: 0,
  stereoWidth: 1.0,
  stages: [],
 },
};

export const SOUND_PRESET_ORDER = ['hd', 'vocal', 'bass', '8d', 'flat'];

// Bộ biến đổi Vibe bài hát thời gian thực (Nightcore / Slowed + Echo / Lo-Fi Đĩa Than) ngay trong luồng PCM mà không cần tạo thêm tiến trình FFmpeg.
export const VIBE_MODES = {
 normal: {
  label: 'Chuẩn Gốc',
  emoji: '🎵',
  description: 'Tốc độ & tông giọng nguyên bản 1.0x của bản thu',
  rate: 1.0,
 },
 nightcore: {
  label: 'Nightcore Sôi Động',
  emoji: '⚡',
  description: 'Tăng tốc 1.20x & nâng tông ca sĩ cao trẻ trung, cực cuốn',
  rate: 1.2,
 },
 slowed: {
  label: 'Slowed + Echo Đêm Muộn',
  emoji: '🌧️',
  description: 'Hạ tốc 0.86x kèm tiếng vang phòng đêm sâu lắng, tâm trạng',
  rate: 0.86,
  echoDelaySamples: 4080, // 85ms vang stereo (~32 KB cấp phát lười khi bật)
 },
 lofi: {
  label: 'Lo-Fi Đĩa Than',
  emoji: '☕',
  description: 'Lọc ấm băng từ cổ điển kèm tiếng đĩa than vinyl dịu nhẹ thư giãn',
  rate: 1.0,
  lofiVinyl: true,
 },
};

export const VIBE_MODE_ORDER = ['normal', 'nightcore', 'slowed', 'lofi'];

// Âm thanh thiên nhiên nền (Ambient Soundscape) tự tổng hợp theo thời gian thực trộn êm dưới nền nhạc (< 1 KB RAM, không cần file MP3 ngoài).
export const AMBIENT_MODES = {
 off: {
  label: 'Tắt nền',
  emoji: '🔇',
  description: 'Không trộn âm thanh thiên nhiên nền',
 },
 rain: {
  label: 'Mưa Đêm Ngoài Hiên',
  emoji: '🌧️',
  description: 'Tiếng mưa rào dịu nhẹ kèm giọt mưa rơi thư giãn đầu óc',
 },
 fire: {
  label: 'Lửa Trại Tí Tách',
  emoji: '🔥',
  description: 'Tiếng củi khô cháy tí tách ấm cúng giữa đêm lạnh',
 },
 ocean: {
  label: 'Sóng Biển Rì Rào',
  emoji: '🌊',
  description: 'Nhịp sóng vỗ bờ xa gần êm ả hai bên tai',
 },
 wind: {
  label: 'Gió Đêm Cao Nguyên',
  emoji: '🍃',
  description: 'Làn gió đêm thoang thoảng qua rừng thông yên bình',
 },
};

export const AMBIENT_MODE_ORDER = ['off', 'rain', 'fire', 'ocean', 'wind'];

// Tính toán hệ số lọc số Biquad chuẩn RBJ Audio EQ Cookbook ở tần số lấy mẫu 48 kHz.
function designBiquad({ type, freq, q = 0.707, gainDb = 0 }, sampleRate = DSP_SAMPLE_RATE) {
 const w0 = (2 * Math.PI * freq) / sampleRate;
 const cosW0 = Math.cos(w0);
 const sinW0 = Math.sin(w0);
 const alpha = sinW0 / (2 * Math.max(0.1, q));
 const A = Math.pow(10, gainDb / 40);

 let b0 = 1, b1 = 0, b2 = 0, a0 = 1, a1 = 0, a2 = 0;
 switch (type) {
  case 'lowpass':
   b0 = (1 - cosW0) / 2;
   b1 = 1 - cosW0;
   b2 = (1 - cosW0) / 2;
   a0 = 1 + alpha;
   a1 = -2 * cosW0;
   a2 = 1 - alpha;
   break;
  case 'highpass':
   b0 = (1 + cosW0) / 2;
   b1 = -(1 + cosW0);
   b2 = (1 + cosW0) / 2;
   a0 = 1 + alpha;
   a1 = -2 * cosW0;
   a2 = 1 - alpha;
   break;
  case 'peaking':
   b0 = 1 + alpha * A;
   b1 = -2 * cosW0;
   b2 = 1 - alpha * A;
   a0 = 1 + alpha / A;
   a1 = -2 * cosW0;
   a2 = 1 - alpha / A;
   break;
  case 'lowshelf': {
   const beta = 2 * Math.sqrt(A) * alpha;
   b0 = A * ((A + 1) - (A - 1) * cosW0 + beta);
   b1 = 2 * A * ((A - 1) - (A + 1) * cosW0);
   b2 = A * ((A + 1) - (A - 1) * cosW0 - beta);
   a0 = (A + 1) + (A - 1) * cosW0 + beta;
   a1 = -2 * ((A - 1) + (A + 1) * cosW0);
   a2 = (A + 1) + (A - 1) * cosW0 - beta;
   break;
  }
  case 'highshelf': {
   const beta = 2 * Math.sqrt(A) * alpha;
   b0 = A * ((A + 1) + (A - 1) * cosW0 + beta);
   b1 = -2 * A * ((A - 1) + (A + 1) * cosW0);
   b2 = A * ((A + 1) + (A - 1) * cosW0 - beta);
   a0 = (A + 1) - (A - 1) * cosW0 + beta;
   a1 = 2 * ((A - 1) - (A + 1) * cosW0);
   a2 = (A + 1) - (A - 1) * cosW0 - beta;
   break;
  }
 }
 return new Float64Array([b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0]);
}

const INTERNAL_SPEECH_PRESETS = {
 loaphuong: {
  preGainDb: -1.5,
  makeupGainDb: 3.4,
  stereoWidth: 0.65,
  stages: [
   { type: 'highpass', freq: 470, q: 0.85, gainDb: 0 },
   { type: 'peaking', freq: 1650, q: 1.35, gainDb: 7.5 },
   { type: 'peaking', freq: 2450, q: 1.2, gainDb: 4.5 },
   { type: 'lowpass', freq: 3150, q: 0.85, gainDb: 0 },
  ],
 },
};

const COMPILED_PRESETS = Object.fromEntries(
 Object.entries({ ...SOUND_PRESETS, ...INTERNAL_SPEECH_PRESETS }).map(([key, cfg]) => [
  key,
  {
   key,
   preGain: Math.pow(10, (cfg.preGainDb ?? 0) / 20),
   makeupGain: Math.pow(10, (cfg.makeupGainDb ?? 0) / 20),
   stereoWidth: Number.isFinite(cfg.stereoWidth) ? cfg.stereoWidth : 1.0,
   orbitStep: cfg.orbitHz > 0 ? (2 * Math.PI * cfg.orbitHz) / DSP_SAMPLE_RATE : 0,
   coeffs: (cfg.stages ?? []).map(stage => designBiquad(stage, DSP_SAMPLE_RATE)),
  },
 ]),
);

// Chuẩn hóa mức phần trăm âm lượng hợp lệ trong khoảng 0% – 200%.
export function clampVolumePercent(value) {
 const num = Number(value);
 if (!Number.isFinite(num)) return 100;
 return Math.min(MAX_VOLUME_PERCENT, Math.max(MIN_VOLUME_PERCENT, Math.round(num)));
}

// Đọc chuỗi mức âm lượng tùy chỉnh người dùng nhập vào (hỗ trợ cả dạng "35", "150", "175%").
export function parseCustomVolumeInput(raw) {
 const cleaned = String(raw ?? '').trim().replace(/%\s*$/, '').trim();
 if (!cleaned || !/^\d+(?:\.\d+)?$/.test(cleaned)) {
  throw new Error(`Hãy nhập một số âm lượng hợp lệ từ ${MIN_VOLUME_PERCENT} đến ${MAX_VOLUME_PERCENT} (ví dụ: 25, 100, 150, 200).`);
 }
 const numeric = Math.round(Number(cleaned));
 if (!Number.isFinite(numeric) || numeric < MIN_VOLUME_PERCENT || numeric > MAX_VOLUME_PERCENT) {
  throw new Error(`Mức âm lượng chỉ nhận từ ${MIN_VOLUME_PERCENT}% đến tối đa ${MAX_VOLUME_PERCENT}%.`);
 }
 return numeric;
}

// Chuyển tỷ lệ âm lượng (0.0 – 2.0) sang hệ số khuếch đại cảm nhận thực tế của tai người (Psychoacoustic Curve):
// - 0%: tắt tiếng hoàn toàn (0.0)
// - 1% – 99%: đường cong lũy thừa x^1.85 giúp giảm về 20% (~ -25.9 dB) hay 50% (~ -11.1 dB) nhỏ đi rõ rệt tự nhiên
// - 100%: giữ nguyên 1.0 (0 dB chuẩn gốc)
// - 101% – 200%: khuếch đại mạnh lên tới +8.4 dB (kết hợp bộ chống vỡ tiếng mềm soft-knee ở đầu ra)
export function computePerceptualGain(volumeRatio) {
 const r = Number(volumeRatio);
 if (!Number.isFinite(r) || r <= 0) return 0;
 if (r === 1) return 1;
 if (r < 1) return Math.pow(r, 1.85);
 return Math.pow(Math.min(r, 4), 1.4);
}

// Bộ giới hạn mềm (Analog Soft-Knee Limiter): giữ nguyên tín hiệu dưới ngưỡng 0.82 và bo tròn mượt trên 0.82
// để khi đẩy âm lượng lên 150% – 200% hoặc bật Bass Căng nhạc vẫn to rõ mà không bị rè/vỡ tiếng kỹ thuật số.
function softLimitSample(x) {
 if (!Number.isFinite(x)) return 0;
 if (x >= -0.82 && x <= 0.82) return x;
 const sign = x < 0 ? -1 : 1;
 const abs = x < 0 ? -x : x;
 return sign * (0.82 + 0.175 * Math.tanh((abs - 0.82) / 0.175));
}

// Mã điều khiển chuẩn của bộ mã hóa libopus (Opus CTL).
const OPUS_CTL = {
 SET_BITRATE: 4002,
 SET_MAX_BANDWIDTH: 4004,
 SET_VBR: 4006,
 SET_COMPLEXITY: 4010,
 SET_INBAND_FEC: 4012,
 SET_PACKET_LOSS_PERC: 4014,
 SET_VBR_CONSTRAINT: 4020,
 SET_SIGNAL: 4024,
 BANDWIDTH_FULLBAND: 1105, // Đủ dải tần âm nhạc 20 kHz
 SIGNAL_MUSIC: 3002,       // Khóa chế độ mã hóa âm nhạc stereo CELT (không bị nhảy sang chế độ thoại VoIP)
};

const LOFI_WARMTH_COEFFS = [
 designBiquad({ type: 'highpass', freq: 105, q: 0.707, gainDb: 0 }, DSP_SAMPLE_RATE),
 designBiquad({ type: 'peaking', freq: 240, q: 0.9, gainDb: 2.8 }, DSP_SAMPLE_RATE),
 designBiquad({ type: 'lowpass', freq: 3950, q: 0.78, gainDb: 0 }, DSP_SAMPLE_RATE),
];

let activePreset = 'hd';
let activeVibe = 'normal';
let activeAmbient = 'off';
let activeAmbientLevel = 0.35; // 10% – 85%
let targetBitrate = 128000;
let installed = false;
let currentEncoder = null;

function applyOpusMusicTuning(opusStream, bitrate) {
 const raw = opusStream?.encoder;
 const ctlFn = raw?.applyEncoderCTL || raw?.encoderCTL;
 if (typeof ctlFn !== 'function') return;
 const safeCtl = (id, value) => {
  try { ctlFn.call(raw, id, value); } catch {}
 };
 const clampedBitrate = Math.min(256000, Math.max(96000, Number(bitrate) || 128000));
 safeCtl(OPUS_CTL.SET_SIGNAL, OPUS_CTL.SIGNAL_MUSIC);
 safeCtl(OPUS_CTL.SET_MAX_BANDWIDTH, OPUS_CTL.BANDWIDTH_FULLBAND);
 safeCtl(OPUS_CTL.SET_COMPLEXITY, 10);
 safeCtl(OPUS_CTL.SET_VBR, 1);
 safeCtl(OPUS_CTL.SET_VBR_CONSTRAINT, 1);
 safeCtl(OPUS_CTL.SET_BITRATE, clampedBitrate);
 safeCtl(OPUS_CTL.SET_INBAND_FEC, 1);
 safeCtl(OPUS_CTL.SET_PACKET_LOSS_PERC, 5);
}

let pendingTransitionFadeSamples = 0;

// Kích hoạt vuốt êm âm lượng chuyển cảnh (Smart Smooth Fade ~360ms, 0 MB RAM, không chạy thêm FFmpeg).
export function triggerSmoothTransitionFade(durationMs = 360) {
 const clampedMs = Math.min(800, Math.max(40, Number(durationMs) || 360));
 pendingTransitionFadeSamples = Math.round((clampedMs / 1000) * 48000);
 return pendingTransitionFadeSamples;
}

// Cập nhật cấu hình chất âm (áp dụng ngay lập tức lên bài đang phát!) và mức bitrate mục tiêu của kênh thoại.
export function setAudioEnhancement({ preset, vibe, ambient, ambientLevel, channelBitrate } = {}) {
 if (preset && SOUND_PRESETS[preset]) {
  activePreset = preset;
 }
 if (vibe && VIBE_MODES[vibe]) {
  activeVibe = vibe;
 }
 if (ambient && AMBIENT_MODES[ambient]) {
  activeAmbient = ambient;
 }
 if (ambientLevel !== undefined && Number.isFinite(Number(ambientLevel))) {
  activeAmbientLevel = Math.min(0.85, Math.max(0.05, Number(ambientLevel)));
 }
 if (channelBitrate) {
  targetBitrate = Math.min(256000, Math.max(128000, Number(channelBitrate) || 128000));
  if (currentEncoder?.encoder) applyOpusMusicTuning(currentEncoder, targetBitrate);
 }
 return {
  preset: activePreset,
  vibe: activeVibe,
  ambient: activeAmbient,
  ambientLevel: activeAmbientLevel,
  bitrate: targetBitrate,
 };
}

export function getActiveAmbientState() {
 return {
  mode: activeAmbient,
  level: activeAmbientLevel,
  levelPercent: Math.round(activeAmbientLevel * 100),
  info: AMBIENT_MODES[activeAmbient] ?? AMBIENT_MODES.off,
 };
}

export function getNextAmbientMode(current = activeAmbient) {
 const idx = AMBIENT_MODE_ORDER.indexOf(current);
 return AMBIENT_MODE_ORDER[(idx + 1) % AMBIENT_MODE_ORDER.length];
}

export function getActiveSoundPreset() {
 return activePreset;
}

export function getNextSoundPreset(current = activePreset) {
 const idx = SOUND_PRESET_ORDER.indexOf(current);
 return SOUND_PRESET_ORDER[(idx + 1) % SOUND_PRESET_ORDER.length];
}

export function getActiveVibeMode() {
 return activeVibe;
}

export function getNextVibeMode(current = activeVibe) {
 const idx = VIBE_MODE_ORDER.indexOf(current);
 return VIBE_MODE_ORDER[(idx + 1) % VIBE_MODE_ORDER.length];
}

// Mở khóa giới hạn âm lượng 0% – 200%, chống tự cắt luồng sau 5 phút & giữ nguyên bài đang tạm dừng không bao giờ nhảy sang bài kế tiếp.
export function configurePlayerAudio(player) {
 if (!player || player.__audioConfigured) return player;
 const graph = player.runtimeGraph;
 const vc = graph?.volumeController;
 const pc = graph?.playbackController;
 const ap = graph?.audioPlayer;
 const sm = graph?.streamManager ?? player.streamManager;
 const sc = graph?.streamController;

 // 1. Khắc phục lỗi StreamManager của ZiPlayer tự hủy luồng nhạc sau 5 phút (gây đứt nhạc hoặc tự nhảy bài khi đang Tạm dừng).
 if (sm && typeof sm.cleanupExpiredStreams === 'function' && !sm.__pauseSafePatched) {
  const origCleanup = sm.cleanupExpiredStreams.bind(sm);
  sm.cleanupExpiredStreams = function patchedCleanupExpiredStreams() {
   const now = Date.now();
   const activeStreamId = sc?.current?.streamId ?? null;
   const currentTrack = player.queue?.currentTrack ?? player.currentTrack ?? null;
   const curKey = currentTrack ? (currentTrack.id || currentTrack.url || currentTrack.title) : null;
   if (this.streams instanceof Map) {
    for (const [id, managed] of this.streams.entries()) {
     const mKey = managed?.track ? (managed.track.id || managed.track.url || managed.track.title) : null;
     const isCurrent = (activeStreamId && id === activeStreamId) || (curKey && mKey === curKey);
     if (isCurrent || managed?.status === 'paused' || (!managed?.metadata?.isPreload && !player.isIdle)) {
      managed.lastAccessed = now;
     }
    }
   }
   return origCleanup();
  };
  sm.__pauseSafePatched = true;
 }

 // 2. Bảo vệ tuyệt đối trạng thái Tạm dừng: nếu ngưng lâu làm CDN đóng kết nối ngầm, giữ nguyên bài đang dừng (KHÔNG nhảy qua bài tiếp theo) và tự nạp lại đúng giây khi bấm Tiếp tục.
 if (pc && ap && !pc.__pauseGuardInstalled) {
  let pausedDropped = null; // { sessionId, positionMs }

  Object.defineProperty(pc, 'status', {
   configurable: true,
   get() {
    if (pausedDropped && pc.activeSession?.id === pausedDropped.sessionId) {
     return 'paused';
    }
    return ap.state?.status;
   },
  });

  if (typeof player.bus?.onAction === 'function') {
   player.bus.onAction(action => {
    if (action?.type === 'STOP' || action?.type === 'SKIP' || action?.type === 'PLAY') {
     pausedDropped = null;
    }
   });
  }

  if (
   typeof pc.onStateChange === 'function' &&
   typeof pc.onError === 'function' &&
   typeof ap.removeListener === 'function' &&
   typeof ap.on === 'function'
  ) {
   ap.removeListener('stateChange', pc.onStateChange);
   ap.removeListener('error', pc.onError);

   const origOnStateChange = pc.onStateChange;
   const origOnError = pc.onError;

   pc.onError = error => {
    const session = pc.activeSession;
    if (session?.isActive?.() && (session.status === 'paused' || ap.state?.status === 'paused')) {
     pausedDropped = {
      sessionId: session.id,
      positionMs: Math.max(0, Number(pc.position ?? session.position ?? 0)),
     };
     pc.clearStuckWatchdog?.();
     return;
    }
    return origOnError(error);
   };

   pc.onStateChange = (oldState, newState) => {
    const session = pc.activeSession;
    if (pausedDropped && session?.id !== pausedDropped.sessionId) {
     pausedDropped = null;
    }
    const wasIntentionallyPaused = Boolean(
     session?.isActive?.() &&
      session.status === 'paused' &&
      (oldState?.status === 'paused' || pausedDropped?.sessionId === session.id),
    );
    if (wasIntentionallyPaused && newState?.status === 'idle') {
     if (!pausedDropped || pausedDropped.sessionId !== session.id) {
      pausedDropped = {
       sessionId: session.id,
       positionMs: Math.max(0, Number(pc.position ?? session.position ?? 0)),
      };
     }
     pc.clearStuckWatchdog?.();
     return;
    }
    if (newState?.status === 'playing') {
     pausedDropped = null;
    }
    return origOnStateChange(oldState, newState);
   };

   ap.on('stateChange', pc.onStateChange);
   ap.on('error', pc.onError);
  }

  if (typeof pc.resume === 'function') {
   const origResume = pc.resume.bind(pc);
   pc.resume = function patchedResume() {
    const session = pc.activeSession;
    if (pausedDropped && session?.isActive?.() && session.id === pausedDropped.sessionId && ap.state?.status === 'idle') {
     const resumePos = pausedDropped.positionMs;
     pausedDropped = null;
     void player.bus?.requestRpc?.('playback.refreshResource', { position: resumePos })?.catch?.(() => {});
     return true;
    }
    pausedDropped = null;
    return origResume();
   };
  }

  if (typeof pc.stop === 'function') {
   const origStop = pc.stop.bind(pc);
   pc.stop = function patchedStop() {
    pausedDropped = null;
    return origStop();
   };
  }

  pc.__pauseGuardInstalled = true;
 }

 if (vc) {
  vc.clamp = value => clampVolumePercent(value);
  if (typeof vc.bindActiveResourceResolver === 'function') {
   vc.bindActiveResourceResolver(() => {
    const resource = pc?.activeResource ?? ap?.state?.resource ?? null;
    const track = pc?.activeSession?.track ?? resource?.metadata ?? null;
    return resource ? { resource, track, gain: pc?.fadeGain ?? 1 } : null;
   });
  }
 }

 player.setVolume = function patchedSetVolume(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < MIN_VOLUME_PERCENT || numeric > MAX_VOLUME_PERCENT) {
   return false;
  }
  const rounded = clampVolumePercent(numeric);
  this.bus.requestRpcSync('volume.set', { value: rounded });
  const fadeGain = Number.isFinite(pc?.fadeGain) ? Math.max(0, pc.fadeGain) : 1;
  const ratio = (rounded / 100) * fadeGain;
  for (const res of new Set([pc?.activeResource, ap?.state?.resource])) {
   if (res?.volume && typeof res.volume.setVolume === 'function') {
    res.volume.setVolume(ratio);
   }
  }
  return true;
 };

 player.__audioConfigured = true;
 return player;
}

// Gắn bộ DSP thời gian thực + Volume 0–200% + Opus Music HD trực tiếp vào đường ống của @discordjs/voice.
export function installAudioEnhancer(ffmpegPath) {
 if (installed) return;
 if (ffmpegPath && !process.env.FFMPEG_PATH) {
  process.env.FFMPEG_PATH = ffmpegPath;
 }

 const req = createRequire(import.meta.url);
 const voiceEntry = req.resolve('@discordjs/voice');
 const prism = createRequire(voiceEntry)('prism-media');

 // 1. Giữ bộ lấy mẫu chuẩn SoX 24-bit sạch nguyên bản trong tiến trình giải mã FFmpeg duy nhất.
 const origCreate = prism.FFmpeg.create.bind(prism.FFmpeg);
 prism.FFmpeg.create = function patchedFFmpegCreate(options = {}) {
  const rawArgs = Array.isArray(options.args) ? [...options.args] : [];
  const analyzeIdx = rawArgs.indexOf('-analyzeduration');
  if (analyzeIdx !== -1 && rawArgs[analyzeIdx + 1] === '0') {
   rawArgs[analyzeIdx + 1] = '500000';
  }
  if (!rawArgs.includes('-af')) {
   const fmtIdx = rawArgs.indexOf('-f');
   const resampleFilter = 'aresample=48000:resampler=soxr:precision=24';
   if (fmtIdx !== -1) {
    rawArgs.splice(fmtIdx, 0, '-af', resampleFilter);
   } else {
    rawArgs.push('-af', resampleFilter);
   }
  }
  return origCreate({ ...options, args: rawArgs });
 };

 // 2. Nâng cấp VolumeTransformer thành Bộ xử lý DSP Studio + Âm lượng cảm nhận 0–200% độ trễ cực thấp (< 80ms).
 const origVolumeTransform = prism.VolumeTransformer.prototype._transform;
 prism.VolumeTransformer.prototype._transform = function patchedRealtimeDspTransform(chunk, encoding, done) {
  if (this._bits !== 16) {
   return origVolumeTransform.call(this, chunk, encoding, done);
  }

  if (!this._dspReady) {
   this._dspReady = true;
   this._dspCarry = Buffer.alloc(0);
   this._dspPresetKey = null;
   this._dspStates = null;
   this._dspRampSamples = 0;
   this._dspOrbitPhase = 0;
   this._dspHaasL = new Float32Array(32);
   this._dspHaasR = new Float32Array(32);
   this._dspHaasIdx = 0;
   this._vibeKey = 'normal';
   this._vibePos = 0;
   this._vibePrevL = 0;
   this._vibePrevR = 0;
   this._vibeHasPrev = false;
   this._echoBufL = null;
   this._echoBufR = null;
   this._echoIdx = 0;
   this._echoLpL = 0;
   this._echoLpR = 0;
   this._lofiStates = null;
   this._lofiSeed = 0x5a17c3d9;
   this._lofiCrackleL = 0;
   this._lofiCrackleR = 0;
   this._ambSeed = 0x9e3779b9;
   this._ambLpL = 0;
   this._ambLpR = 0;
   this._ambBpL = 0;
   this._ambBpR = 0;
   this._ambSparkL = 0;
   this._ambSparkR = 0;
   this._ambPhase = 0;
   // Vuốt êm vào bài (mặc định 45ms chống nổ lụp bụp; hoặc 360ms khi chuyển bài / tua nhạc; bỏ qua cho /sfx & /tts).
   const initFadeSamples = this._forcePresetKey
    ? 0
    : (pendingTransitionFadeSamples > 0 ? pendingTransitionFadeSamples : 2160);
   if (!this._forcePresetKey && pendingTransitionFadeSamples > 0) {
    pendingTransitionFadeSamples = 0;
   }
   this._microFadeTotal = initFadeSamples;
   this._microFadeLeft = initFadeSamples;
   this._dspCurrentGain = computePerceptualGain(this.volume);
   if (this._readableState) this._readableState.highWaterMark = LOW_LATENCY_PCM_HWM;
   if (this._writableState) this._writableState.highWaterMark = LOW_LATENCY_PCM_HWM;
  } else if (!this._forcePresetKey && pendingTransitionFadeSamples > 0) {
   this._microFadeTotal = pendingTransitionFadeSamples;
   this._microFadeLeft = pendingTransitionFadeSamples;
   pendingTransitionFadeSamples = 0;
  }

  const input = this._dspCarry.length > 0 ? Buffer.concat([this._dspCarry, chunk]) : chunk;
  if (input.length < STEREO_BYTES) {
   this._dspCarry = Buffer.from(input);
   return done();
  }

  const complete = Math.floor(input.length / STEREO_BYTES) * STEREO_BYTES;
  this._dspCarry = input.length > complete ? Buffer.from(input.subarray(complete)) : Buffer.alloc(0);

  const forcedKey = this._forcePresetKey;
  const forcedRate = Number(this._forceRate) > 0 ? Number(this._forceRate) : 1.0;
  const forcedEcho = Boolean(this._forceEcho);
  const vibeKey = forcedKey ? 'normal' : (VIBE_MODES[activeVibe] ? activeVibe : 'normal');
  const vibeCfg = VIBE_MODES[vibeKey];
  const wantEcho = vibeKey === 'slowed' || forcedEcho;
  const echoStateTag = wantEcho ? (forcedEcho ? 'cave' : 'slowed') : 'none';
  if (this._vibeKey !== `${vibeKey}:${echoStateTag}`) {
   this._vibeKey = `${vibeKey}:${echoStateTag}`;
   if (wantEcho) {
    const echoLen = forcedEcho ? 5400 : (vibeCfg.echoDelaySamples || 4080);
    this._echoBufL = new Float32Array(echoLen);
    this._echoBufR = new Float32Array(echoLen);
    this._echoIdx = 0;
    this._echoLpL = 0;
    this._echoLpR = 0;
   } else {
    this._echoBufL = null;
    this._echoBufR = null;
   }
   if (vibeKey === 'lofi') {
    this._lofiStates = new Float64Array(LOFI_WARMTH_COEFFS.length * 4);
   } else {
    this._lofiStates = null;
   }
  }

  const effectiveRate = forcedKey ? forcedRate : vibeCfg.rate;
  let workBuf = input;
  let workBytes = complete;
  const inFrames = complete >> 2;
  if (inFrames > 0) {
   const lastByte = (inFrames - 1) * STEREO_BYTES;
   const endSampleL = this._readInt(input, lastByte);
   const endSampleR = this._readInt(input, lastByte + 2);
   if (!this._vibeHasPrev) {
    this._vibePrevL = this._readInt(input, 0);
    this._vibePrevR = this._readInt(input, 2);
    this._vibeHasPrev = true;
   }
   if (effectiveRate !== 1.0) {
    const rate = effectiveRate;
    let pos = this._vibePos;
    const estFrames = Math.max(0, Math.ceil((inFrames - pos) / rate));
    if (estFrames === 0) {
     this._vibePos = Math.max(0, pos - inFrames);
     this._vibePrevL = endSampleL;
     this._vibePrevR = endSampleR;
     return done();
    }
    const resampled = Buffer.allocUnsafe(estFrames * STEREO_BYTES);
    let outFrames = 0;
    const prevL = this._vibePrevL;
    const prevR = this._vibePrevR;
    while (pos < inFrames && outFrames < estFrames) {
     const i1 = Math.floor(pos);
     const frac = pos - i1;
     const l0 = i1 === 0 ? prevL : this._readInt(input, (i1 - 1) * STEREO_BYTES);
     const r0 = i1 === 0 ? prevR : this._readInt(input, (i1 - 1) * STEREO_BYTES + 2);
     const l1 = this._readInt(input, i1 * STEREO_BYTES);
     const r1 = this._readInt(input, i1 * STEREO_BYTES + 2);
     const sL = Math.round(l0 + (l1 - l0) * frac);
     const sR = Math.round(r0 + (r1 - r0) * frac);
     this._writeInt(resampled, sL, outFrames * STEREO_BYTES);
     this._writeInt(resampled, sR, outFrames * STEREO_BYTES + 2);
     outFrames++;
     pos += rate;
    }
    this._vibePos = Math.max(0, pos - inFrames);
    workBytes = outFrames * STEREO_BYTES;
    workBuf = workBytes === resampled.length ? resampled : resampled.subarray(0, workBytes);
   } else {
    this._vibePos = 0;
   }
   this._vibePrevL = endSampleL;
   this._vibePrevR = endSampleR;
  }
  if (workBytes < STEREO_BYTES) return done();
  const presetKey = forcedKey && COMPILED_PRESETS[forcedKey]
   ? forcedKey
   : (COMPILED_PRESETS[activePreset] ? activePreset : 'hd');
  const preset = COMPILED_PRESETS[presetKey];
  const coeffsList = preset.coeffs;
  const numStages = coeffsList.length;

  if (this._dspPresetKey !== presetKey) {
   const hadPrevious = this._dspPresetKey !== null;
   this._dspPresetKey = presetKey;
   this._dspStates = new Float64Array(numStages * 4);
   // Làm mượt 192 mẫu (4ms) khi chuyển chất âm giữa chừng để không có tiếng "tách" nhỏ.
   this._dspRampSamples = hadPrevious ? 192 : 0;
  }

  const states = this._dspStates;
  const preGain = preset.preGain;
  const makeupGain = preset.makeupGain;
  const width = preset.stereoWidth;
  const orbitStep = preset.orbitStep;
  const targetGain = computePerceptualGain(this.volume);
  let currentGain = this._dspCurrentGain;
  let ramp = this._dspRampSamples;
  let orbitPhase = this._dspOrbitPhase;
  const haasL = this._dspHaasL;
  const haasR = this._dspHaasR;
  let haasIdx = this._dspHaasIdx;

  const echoBufL = this._echoBufL;
  const echoBufR = this._echoBufR;
  const echoLen = echoBufL ? echoBufL.length : 0;
  let echoIdx = this._echoIdx;
  let echoLpL = this._echoLpL;
  let echoLpR = this._echoLpR;
  const lofiStates = this._lofiStates;
  let lofiSeed = this._lofiSeed;
  let crackleL = this._lofiCrackleL;
  let crackleR = this._lofiCrackleR;

  const ambMode = forcedKey ? 'off' : activeAmbient;
  const ambGain = ambMode !== 'off' ? activeAmbientLevel * 0.14 : 0;
  let ambSeed = this._ambSeed;
  let ambLpL = this._ambLpL;
  let ambLpR = this._ambLpR;
  let ambBpL = this._ambBpL;
  let ambBpR = this._ambBpR;
  let ambSparkL = this._ambSparkL;
  let ambSparkR = this._ambSparkR;
  let ambPhase = this._ambPhase;
  let microFadeLeft = this._microFadeLeft || 0;
  const microFadeTotal = this._microFadeTotal || 1;
  const echoFeedback = forcedEcho ? 0.42 : 0.3;
  const echoWet = forcedEcho ? 0.38 : 0.25;

  const out = Buffer.allocUnsafe(workBytes);
  for (let i = 0; i < workBytes; i += STEREO_BYTES) {
   // Làm mượt thay đổi âm lượng (exponential slewing ~10ms) chống tiếng nổ lụp bụp khi kéo gấp.
   currentGain += (targetGain - currentGain) * 0.005;

   const dryL = this._readInt(workBuf, i) / 32768;
   const dryR = this._readInt(workBuf, i + 2) / 32768;

   let l = dryL;
   let r = dryR;

   // Vang không gian Slowed + Echo đêm muộn / Vang Hang Động TTS
   if (echoLen > 0) {
    echoLpL = echoLpL * 0.68 + echoBufR[echoIdx] * 0.32;
    echoLpR = echoLpR * 0.68 + echoBufL[echoIdx] * 0.32;
    echoBufL[echoIdx] = l + echoLpL * echoFeedback;
    echoBufR[echoIdx] = r + echoLpR * echoFeedback;
    l = l * 0.86 + echoLpL * echoWet;
    r = r * 0.86 + echoLpR * echoWet;
    echoIdx++;
    if (echoIdx >= echoLen) echoIdx = 0;
   }

   // Chất màu Lo-Fi Đĩa Than ấm áp + hạt bụi đĩa vinyl cực dịu
   if (lofiStates) {
    for (let s = 0; s < LOFI_WARMTH_COEFFS.length; s++) {
     const c = LOFI_WARMTH_COEFFS[s];
     const stIdx = s * 4;
     const yL = c[0] * l + lofiStates[stIdx];
     lofiStates[stIdx] = c[1] * l - c[3] * yL + lofiStates[stIdx + 1];
     lofiStates[stIdx + 1] = c[2] * l - c[4] * yL;
     l = yL;

     const yR = c[0] * r + lofiStates[stIdx + 2];
     lofiStates[stIdx + 2] = c[1] * r - c[3] * yR + lofiStates[stIdx + 3];
     lofiStates[stIdx + 3] = c[2] * r - c[4] * yR;
     r = yR;
    }
    lofiSeed = (lofiSeed * 1664525 + 1013904223) >>> 0;
    if ((lofiSeed & 0x3fff) === 0x1357) {
     const pop = (((lofiSeed >>> 16) & 0xff) / 255) * 0.011;
     if (lofiSeed & 0x10000) crackleL += pop;
     else crackleR += pop;
    }
    crackleL *= 0.94;
    crackleR *= 0.94;
    const hiss = (((lofiSeed & 0xffff) / 32768) - 1) * 0.0008;
    l = Math.tanh(l * 1.15) * 0.9 + crackleL + hiss;
    r = Math.tanh(r * 1.15) * 0.9 + crackleR - hiss * 0.6;
   }

   if (numStages > 0 || width !== 1 || orbitStep > 0) {
    l *= preGain;
    r *= preGain;

    for (let s = 0; s < numStages; s++) {
     const c = coeffsList[s];
     const stIdx = s * 4;
     const b0 = c[0], b1 = c[1], b2 = c[2], a1 = c[3], a2 = c[4];

     const yL = b0 * l + states[stIdx];
     states[stIdx] = b1 * l - a1 * yL + states[stIdx + 1];
     states[stIdx + 1] = b2 * l - a2 * yL;
     l = yL;

     const yR = b0 * r + states[stIdx + 2];
     states[stIdx + 2] = b1 * r - a1 * yR + states[stIdx + 3];
     states[stIdx + 3] = b2 * r - a2 * yR;
     r = yR;
    }

    if (width !== 1) {
     const mid = (l + r) * 0.5;
     const side = (l - r) * 0.5 * width;
     l = mid + side;
     r = mid - side;
    }

    // Hiệu ứng âm thanh vòm 8D xoay quanh đầu 360° (cân bằng công suất + độ trễ Haas 2 tai siêu thực)
    if (orbitStep > 0) {
     orbitPhase += orbitStep;
     if (orbitPhase >= 6.283185307179586) orbitPhase -= 6.283185307179586;

     haasL[haasIdx] = l;
     haasR[haasIdx] = r;

     const pan = Math.sin(orbitPhase);
     const depth = 0.9 + 0.1 * Math.cos(orbitPhase);
     const theta = (pan + 1) * 0.7853981633974483; // [0 .. PI/2]
     const gainL = (0.18 + 0.88 * Math.cos(theta)) * depth;
     const gainR = (0.18 + 0.88 * Math.sin(theta)) * depth;

     const delayL = pan > 0 ? Math.round(pan * 22) : 0;
     const delayR = pan < 0 ? Math.round(-pan * 22) : 0;
     const delayedL = haasL[(haasIdx - delayL + 32) & 31];
     const delayedR = haasR[(haasIdx - delayR + 32) & 31];
     const monoCenter = (delayedL + delayedR) * 0.5;

     l = (delayedL * 0.62 + monoCenter * 0.38) * gainL;
     r = (delayedR * 0.62 + monoCenter * 0.38) * gainR;
     haasIdx = (haasIdx + 1) & 31;
    }

    l *= makeupGain;
    r *= makeupGain;

    if (ramp > 0) {
     const wetMix = (192 - ramp) / 192;
     l = dryL * (1 - wetMix) + l * wetMix;
     r = dryR * (1 - wetMix) + r * wetMix;
     ramp--;
    }
   }

   // Lớp âm thanh thiên nhiên nền (/ambient: Mưa rơi / Lửa trại / Sóng biển / Gió đêm)
   if (ambGain > 0) {
    ambSeed = (ambSeed * 1664525 + 1013904223) >>> 0;
    const nL = (((ambSeed & 0xffff) / 32768) - 1);
    ambSeed = (ambSeed * 1664525 + 1013904223) >>> 0;
    const nR = (((ambSeed & 0xffff) / 32768) - 1);

    let bedL = 0;
    let bedR = 0;
    if (ambMode === 'rain') {
     ambLpL = ambLpL * 0.82 + nL * 0.18;
     ambLpR = ambLpR * 0.82 + nR * 0.18;
     ambBpL = ambBpL * 0.96 + ambLpL * 0.04;
     ambBpR = ambBpR * 0.96 + ambLpR * 0.04;
     if ((ambSeed & 0x1fff) === 0x0777) {
      const drop = (((ambSeed >>> 16) & 0xff) / 255) * 0.55;
      if (ambSeed & 0x10000) ambSparkL += drop;
      else ambSparkR += drop;
     }
     ambSparkL *= 0.965;
     ambSparkR *= 0.965;
     bedL = (ambLpL - ambBpL * 0.55) * 0.85 + ambSparkL * 0.35;
     bedR = (ambLpR - ambBpR * 0.55) * 0.85 + ambSparkR * 0.35;
    } else if (ambMode === 'fire') {
     ambLpL = ambLpL * 0.985 + nL * 0.015;
     ambLpR = ambLpR * 0.985 + nR * 0.015;
     if ((ambSeed & 0x17ff) === 0x0521) {
      const snap = (0.35 + (((ambSeed >>> 16) & 0xff) / 255) * 0.75);
      if (ambSeed & 0x20000) ambSparkL += snap;
      else ambSparkR += snap;
     }
     ambSparkL *= 0.92;
     ambSparkR *= 0.92;
     bedL = ambLpL * 1.45 + ambSparkL * nL * 0.9;
     bedR = ambLpR * 1.45 + ambSparkR * nR * 0.9;
    } else if (ambMode === 'ocean') {
     ambPhase += 0.0000145; // Chu kỳ sóng vỗ ~9 giây
     if (ambPhase >= 6.283185307179586) ambPhase -= 6.283185307179586;
     const waveL = 0.28 + 0.72 * Math.pow((Math.sin(ambPhase) + 1) * 0.5, 1.7);
     const waveR = 0.28 + 0.72 * Math.pow((Math.sin(ambPhase - 0.85) + 1) * 0.5, 1.7);
     const coef = 0.94 - waveL * 0.14;
     ambLpL = ambLpL * coef + nL * (1 - coef);
     ambLpR = ambLpR * coef + nR * (1 - coef);
     bedL = ambLpL * waveL * 1.1;
     bedR = ambLpR * waveR * 1.1;
    } else if (ambMode === 'wind') {
     ambPhase += 0.0000115;
     if (ambPhase >= 6.283185307179586) ambPhase -= 6.283185307179586;
     const gust = 0.35 + 0.65 * ((Math.sin(ambPhase) * 0.6 + Math.cos(ambPhase * 2.3) * 0.4 + 1) * 0.5);
     ambLpL = ambLpL * 0.965 + nL * 0.035;
     ambLpR = ambLpR * 0.965 + nR * 0.035;
     ambBpL = ambBpL * 0.992 + ambLpL * 0.008;
     ambBpR = ambBpR * 0.992 + ambLpR * 0.008;
     bedL = (ambLpL - ambBpL) * gust * 2.1;
     bedR = (ambLpR - ambBpR) * gust * 2.1;
    }
    l += bedL * ambGain;
    r += bedR * ambGain;
   }

   let fadeEnv = 1;
   if (microFadeLeft > 0) {
    const progress = 1 - (microFadeLeft / microFadeTotal);
    // Đường cong Sine-squared êm tai tự nhiên như bàn mixer phòng thu
    fadeEnv = Math.sin(progress * 1.5707963267948966);
    fadeEnv *= fadeEnv;
    microFadeLeft--;
   }

   const outL = softLimitSample(l * currentGain * fadeEnv);
   const outR = softLimitSample(r * currentGain * fadeEnv);

   this._writeInt(out, Math.max(-32768, Math.min(32767, Math.round(outL * 32767))), i);
   this._writeInt(out, Math.max(-32768, Math.min(32767, Math.round(outR * 32767))), i + 2);
  }

  this._microFadeLeft = microFadeLeft;
  this._dspCurrentGain = Math.abs(targetGain - currentGain) < 1e-6 ? targetGain : currentGain;
  this._dspRampSamples = ramp;
  this._dspOrbitPhase = orbitPhase;
  this._dspHaasIdx = haasIdx;
  this._echoIdx = echoIdx;
  this._echoLpL = echoLpL;
  this._echoLpR = echoLpR;
  this._lofiSeed = lofiSeed;
  this._lofiCrackleL = crackleL;
  this._lofiCrackleR = crackleR;
  this._ambSeed = ambSeed;
  this._ambLpL = ambLpL;
  this._ambLpR = ambLpR;
  this._ambBpL = ambBpL;
  this._ambBpR = ambBpR;
  this._ambSparkL = ambSparkL;
  this._ambSparkR = ambSparkR;
  this._ambPhase = ambPhase;

  for (let off = 0; off < workBytes; off += OPUS_FRAME_BYTES) {
   this.push(out.subarray(off, Math.min(workBytes, off + OPUS_FRAME_BYTES)));
  }
  return done();
 };

 // 3. Khóa bộ mã hóa Opus sang chế độ Âm nhạc chuyên dụng (CELT Fullband 20 kHz) & giảm hàng đợi gói tin đệm còn 80ms.
 const tunedInstances = new WeakSet();
 const origEncode = prism.opus.Encoder.prototype._encode;
 prism.opus.Encoder.prototype._encode = function patchedOpusEncode(buffer) {
  if (!tunedInstances.has(this)) {
   tunedInstances.add(this);
   currentEncoder = this;
   if (this._readableState) this._readableState.highWaterMark = LOW_LATENCY_OPUS_HWM;
   if (this._writableState) this._writableState.highWaterMark = LOW_LATENCY_PCM_HWM;
   applyOpusMusicTuning(this, targetBitrate);
  }
  return origEncode.call(this, buffer);
 };

 installed = true;
}
