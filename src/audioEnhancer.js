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

export const SOUND_PRESET_ORDER = ['hd', 'vocal', 'bass', 'flat'];

// Tính toán hệ số lọc số Biquad chuẩn RBJ Audio EQ Cookbook ở tần số lấy mẫu 48 kHz.
function designBiquad({ type, freq, q = 0.707, gainDb = 0 }, sampleRate = DSP_SAMPLE_RATE) {
 const w0 = (2 * Math.PI * freq) / sampleRate;
 const cosW0 = Math.cos(w0);
 const sinW0 = Math.sin(w0);
 const alpha = sinW0 / (2 * Math.max(0.1, q));
 const A = Math.pow(10, gainDb / 40);

 let b0 = 1, b1 = 0, b2 = 0, a0 = 1, a1 = 0, a2 = 0;
 switch (type) {
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

const COMPILED_PRESETS = Object.fromEntries(
 Object.entries(SOUND_PRESETS).map(([key, cfg]) => [
  key,
  {
   key,
   preGain: Math.pow(10, (cfg.preGainDb ?? 0) / 20),
   makeupGain: Math.pow(10, (cfg.makeupGainDb ?? 0) / 20),
   stereoWidth: Number.isFinite(cfg.stereoWidth) ? cfg.stereoWidth : 1.0,
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

let activePreset = 'hd';
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

// Cập nhật cấu hình chất âm (áp dụng ngay lập tức lên bài đang phát!) và mức bitrate mục tiêu của kênh thoại.
export function setAudioEnhancement({ preset, channelBitrate } = {}) {
 if (preset && SOUND_PRESETS[preset]) {
  activePreset = preset;
 }
 if (channelBitrate) {
  targetBitrate = Math.min(256000, Math.max(128000, Number(channelBitrate) || 128000));
  if (currentEncoder?.encoder) applyOpusMusicTuning(currentEncoder, targetBitrate);
 }
 return { preset: activePreset, bitrate: targetBitrate };
}

export function getActiveSoundPreset() {
 return activePreset;
}

export function getNextSoundPreset(current = activePreset) {
 const idx = SOUND_PRESET_ORDER.indexOf(current);
 return SOUND_PRESET_ORDER[(idx + 1) % SOUND_PRESET_ORDER.length];
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
   this._dspCurrentGain = computePerceptualGain(this.volume);
   if (this._readableState) this._readableState.highWaterMark = LOW_LATENCY_PCM_HWM;
   if (this._writableState) this._writableState.highWaterMark = LOW_LATENCY_PCM_HWM;
  }

  const input = this._dspCarry.length > 0 ? Buffer.concat([this._dspCarry, chunk]) : chunk;
  if (input.length < STEREO_BYTES) {
   this._dspCarry = Buffer.from(input);
   return done();
  }

  const complete = Math.floor(input.length / STEREO_BYTES) * STEREO_BYTES;
  this._dspCarry = input.length > complete ? Buffer.from(input.subarray(complete)) : Buffer.alloc(0);

  const presetKey = COMPILED_PRESETS[activePreset] ? activePreset : 'hd';
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
  const targetGain = computePerceptualGain(this.volume);
  let currentGain = this._dspCurrentGain;
  let ramp = this._dspRampSamples;

  const out = Buffer.allocUnsafe(complete);
  for (let i = 0; i < complete; i += STEREO_BYTES) {
   // Làm mượt thay đổi âm lượng (exponential slewing ~10ms) chống tiếng nổ lụp bụp khi kéo gấp.
   currentGain += (targetGain - currentGain) * 0.005;

   const dryL = this._readInt(input, i) / 32768;
   const dryR = this._readInt(input, i + 2) / 32768;

   let l = dryL;
   let r = dryR;

   if (numStages > 0 || width !== 1) {
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

    l *= makeupGain;
    r *= makeupGain;

    if (ramp > 0) {
     const wetMix = (192 - ramp) / 192;
     l = dryL * (1 - wetMix) + l * wetMix;
     r = dryR * (1 - wetMix) + r * wetMix;
     ramp--;
    }
   }

   const outL = softLimitSample(l * currentGain);
   const outR = softLimitSample(r * currentGain);

   this._writeInt(out, Math.max(-32768, Math.min(32767, Math.round(outL * 32767))), i);
   this._writeInt(out, Math.max(-32768, Math.min(32767, Math.round(outR * 32767))), i + 2);
  }

  this._dspCurrentGain = Math.abs(targetGain - currentGain) < 1e-6 ? targetGain : currentGain;
  this._dspRampSamples = ramp;

  for (let off = 0; off < complete; off += OPUS_FRAME_BYTES) {
   this.push(out.subarray(off, Math.min(complete, off + OPUS_FRAME_BYTES)));
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
