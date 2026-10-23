import { createRequire } from 'node:module';

// Các cấu hình lọc âm thanh chạy trực tiếp trong tiến trình FFmpeg giải mã sẵn có (không tạo thêm tiến trình phụ, không tốn thêm RAM).
export const SOUND_PRESETS = {
 hd: {
  label: 'Rõ nét HD',
  description: 'Lấy mẫu SoX 24-bit, làm trong giọng hát & âm cao, chống rè tiếng',
  filter: 'aresample=48000:resampler=soxr:precision=24,highpass=f=28,equalizer=f=3600:t=q:w=1.2:g=1.8,treble=g=1.6:f=9500:w=0.6,alimiter=limit=0.95:attack=5:release=50:level=false',
 },
 vocal: {
  label: 'Rõ lời & Sáng tiếng',
  description: 'Tôn giọng ca sĩ, giảm âm đục trầm và cân bằng âm lượng lời hát',
  filter: 'aresample=48000:resampler=soxr:precision=24,highpass=f=45,equalizer=f=220:t=q:w=1.1:g=-1.5,equalizer=f=3400:t=q:w=1.1:g=2.8,treble=g=2.4:f=9000:w=0.6,acompressor=threshold=-16dB:ratio=1.7:attack=15:release=180:makeup=1.25,alimiter=limit=0.95:attack=5:release=50:level=false',
 },
 bass: {
  label: 'Bass ấm & Rõ nét',
  description: 'Tăng lực âm trầm gọn chắc nhưng vẫn giữ độ sáng của lời hát',
  filter: 'aresample=48000:resampler=soxr:precision=24,highpass=f=25,bass=g=4.0:f=85:w=0.6,equalizer=f=260:t=q:w=1.2:g=-1.2,equalizer=f=3600:t=q:w=1.2:g=1.8,treble=g=1.5:f=9500:w=0.6,alimiter=limit=0.94:attack=5:release=50:level=false',
 },
 flat: {
  label: 'Nguyên bản',
  description: 'Giữ nguyên EQ gốc, chỉ bật lấy mẫu chuẩn SoX 24-bit và chống vỡ tiếng',
  filter: 'aresample=48000:resampler=soxr:precision=24,alimiter=limit=0.97:attack=5:release=50:level=false',
 },
};

export const SOUND_PRESET_ORDER = ['hd', 'vocal', 'bass', 'flat'];

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

// Cập nhật cấu hình chất âm và mức bitrate mục tiêu theo kênh thoại Discord hiện tại.
export function setAudioEnhancement({ preset, channelBitrate } = {}) {
 if (preset && SOUND_PRESETS[preset]) {
  activePreset = preset;
 }
 if (channelBitrate) {
  // Luôn giữ tối thiểu 128 kbps ở đầu ra bộ mã hóa (hoặc cao hơn tới 256 kbps nếu máy chủ có Boost kênh thoại).
  targetBitrate = Math.min(256000, Math.max(128000, Number(channelBitrate) || 128000));
  if (currentEncoder?.encoder) applyOpusMusicTuning(currentEncoder, targetBitrate);
 }
 return { preset: activePreset, bitrate: targetBitrate };
}

export function getNextSoundPreset(current = activePreset) {
 const idx = SOUND_PRESET_ORDER.indexOf(current);
 return SOUND_PRESET_ORDER[(idx + 1) % SOUND_PRESET_ORDER.length];
}

// Gắn bộ tối ưu hóa trực tiếp vào đường ống FFmpeg + Opus của @discordjs/voice (chạy 1 lần khi khởi động).
export function installAudioEnhancer(ffmpegPath) {
 if (installed) return;
 if (ffmpegPath && !process.env.FFMPEG_PATH) {
  process.env.FFMPEG_PATH = ffmpegPath;
 }

 const req = createRequire(import.meta.url);
 const voiceEntry = req.resolve('@discordjs/voice');
 const prism = createRequire(voiceEntry)('prism-media');

 // 1. Nâng chất lượng giải mã & lấy mẫu lại âm thanh ngay trong tiến trình FFmpeg duy nhất của @discordjs/voice.
 const origCreate = prism.FFmpeg.create.bind(prism.FFmpeg);
 prism.FFmpeg.create = function patchedFFmpegCreate(options = {}) {
  const rawArgs = Array.isArray(options.args) ? [...options.args] : [];
  const analyzeIdx = rawArgs.indexOf('-analyzeduration');
  if (analyzeIdx !== -1 && rawArgs[analyzeIdx + 1] === '0') {
   rawArgs[analyzeIdx + 1] = '500000';
  }
  const presetCfg = SOUND_PRESETS[activePreset] ?? SOUND_PRESETS.hd;
  if (presetCfg?.filter && !rawArgs.includes('-af')) {
   const fmtIdx = rawArgs.indexOf('-f');
   if (fmtIdx !== -1) {
    rawArgs.splice(fmtIdx, 0, '-af', presetCfg.filter);
   } else {
    rawArgs.push('-af', presetCfg.filter);
   }
  }
  return origCreate({ ...options, args: rawArgs });
 };

 // 2. Khóa bộ mã hóa Opus sang chế độ Âm nhạc chuyên dụng (CELT Fullband 20 kHz, độ chi tiết 10, chống rớt gói FEC).
 const tunedInstances = new WeakSet();
 const origEncode = prism.opus.Encoder.prototype._encode;
 prism.opus.Encoder.prototype._encode = function patchedOpusEncode(buffer) {
  if (!tunedInstances.has(this)) {
   tunedInstances.add(this);
   currentEncoder = this;
   applyOpusMusicTuning(this, targetBitrate);
  }
  return origEncode.call(this, buffer);
 };

 installed = true;
}
