// Bộ tổng hợp hiệu ứng âm thanh Meme phòng thoại (Procedural Studio PCM 44.1kHz Stereo):
// Tạo tức thì trong < 3ms bằng toán học thuần, tốn 0 MB RAM chờ, không phụ thuộc link ngoài, không bao giờ lỗi 404.

const SAMPLE_RATE = 44100;

export const SFX_PRESETS = Object.freeze({
 badumtss: {
  id: 'badumtss',
  label: '🥁 Trống Ba-dum-tss (Chốt câu tấu hài)',
 },
 crickets: {
  id: 'crickets',
  label: '🦗 Tiếng dế kêu (Quê độ / Im phăng phắc)',
 },
 airhorn: {
  id: 'airhorn',
  label: '📯 Còi hơi Airhorn (Khuấy động phòng)',
 },
 bassdrop: {
  id: 'bassdrop',
  label: '💥 Bass Drop Cực Căng (Sub-bass chấn động)',
 },
 sadtrombone: {
  id: 'sadtrombone',
  label: '🎺 Kèn quê độ Wah-Wah-Waaah (Thất bại)',
 },
 winxp: {
  id: 'winxp',
  label: '💻 Windows XP Tắt máy (Tạm biệt đi ngủ)',
 },
 applause: {
  id: 'applause',
  label: '🎉 Kèn Fanfare & Pháo tay chúc mừng',
 },
 beep: {
  id: 'beep',
  label: '🤬 Tiếng Bíp che từ nhạy cảm (Censor 1kHz)',
 },
});

function createStereoWav(durationSec, renderFn) {
 const totalSamples = Math.max(1, Math.floor(SAMPLE_RATE * durationSec));
 const dataBytes = totalSamples * 4;
 const buf = Buffer.allocUnsafe(44 + dataBytes);

 buf.write('RIFF', 0);
 buf.writeUInt32LE(36 + dataBytes, 4);
 buf.write('WAVEfmt ', 8);
 buf.writeUInt32LE(16, 16);
 buf.writeUInt16LE(1, 20); // PCM
 buf.writeUInt16LE(2, 22); // Stereo
 buf.writeUInt32LE(SAMPLE_RATE, 24);
 buf.writeUInt32LE(SAMPLE_RATE * 4, 28);
 buf.writeUInt16LE(4, 32);
 buf.writeUInt16LE(16, 34);
 buf.write('data', 36);
 buf.writeUInt32LE(dataBytes, 40);

 // Bộ sinh nhiễu giả ngẫu nhiên tất định siêu nhanh
 let seed = 0x12345678;
 const nextNoise = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return (seed / 0x80000000) - 1;
 };

 for (let i = 0; i < totalSamples; i++) {
  const t = i / SAMPLE_RATE;
  const [rawL, rawR] = renderFn(t, i, nextNoise);
  const sL = Math.max(-1, Math.min(1, rawL));
  const sR = Math.max(-1, Math.min(1, rawR));
  buf.writeInt16LE(Math.round(sL * 30000), 44 + i * 4);
  buf.writeInt16LE(Math.round(sR * 30000), 46 + i * 4);
 }

 return buf;
}

function renderEffectBuffer(effectId) {
 switch (effectId) {
  case 'badumtss':
   return createStereoWav(1.85, (t, _i, noise) => {
     let v = 0;
     // "Ba" (0.00s): trống trầm
     if (t < 0.25) {
      const dt = t;
      const f = 70 + 110 * Math.exp(-dt * 28);
      v += Math.sin(2 * Math.PI * f * dt) * Math.exp(-dt * 14) * 0.9;
     }
     // "Dum" (0.22s): trống tom kèm chút snare
     if (t >= 0.22 && t < 0.52) {
      const dt = t - 0.22;
      const f = 115 + 95 * Math.exp(-dt * 24);
      v += (Math.sin(2 * Math.PI * f * dt) * 0.8 + noise() * 0.22) * Math.exp(-dt * 12) * 0.85;
     }
     // "Tssss" (0.50s): chũm chọe crash kim loại stereo rộng
     if (t >= 0.5) {
      const dt = t - 0.5;
      const env = Math.exp(-dt * 3.1);
      const metallic =
       Math.sin(2 * Math.PI * 3420 * dt) * 0.18 +
       Math.sin(2 * Math.PI * 5180 * dt) * 0.16 +
       Math.sin(2 * Math.PI * 7410 * dt) * 0.14;
      const nL = (noise() * 0.58 + metallic) * env * 0.8;
      const nR = (noise() * 0.58 - metallic) * env * 0.8;
      return [v + nL, v + nR];
     }
     return [v, v];
    });

  case 'crickets':
   return createStereoWav(2.4, t => {
     // 2 cụm dế kêu: [0.05..0.75] và [1.15..1.85]
     const inBout = (t >= 0.05 && t <= 0.78) || (t >= 1.18 && t <= 1.92);
     if (!inBout) return [0, 0];
     const pulse = Math.max(0, Math.sin(2 * Math.PI * 26 * t));
     const carrier =
      Math.sin(2 * Math.PI * 4350 * t) * 0.72 +
      Math.sin(2 * Math.PI * 8700 * t) * 0.22;
     const s = carrier * Math.pow(pulse, 2.2) * 0.65;
     return [s * 0.92, s * 1.0];
    });

  case 'airhorn': {
   let p1 = 0, p2 = 0, p3 = 0;
   return createStereoWav(1.95, t => {
     const on =
      (t >= 0.0 && t < 0.18) ||
      (t >= 0.24 && t < 0.42) ||
      (t >= 0.48 && t < 1.85);
     if (!on) return [0, 0];
     const env = t >= 0.48 ? Math.min(1, (1.85 - t) * 3.2) : 1;
     const bend = 1 + 0.025 * Math.sin(2 * Math.PI * 7 * t);
     p1 += (392 * bend) / SAMPLE_RATE;
     p2 += (493.88 * bend) / SAMPLE_RATE;
     p3 += (598 * bend) / SAMPLE_RATE;
     const saw = p => 2 * (p - Math.floor(p + 0.5));
     const raw = (saw(p1) * 0.42 + saw(p2) * 0.34 + saw(p3) * 0.28) * env;
     const clipped = Math.tanh(raw * 2.4) * 0.78;
     return [clipped * 0.96, clipped];
    });
  }

  case 'bassdrop': {
   let phase = 0;
   return createStereoWav(2.1, (t, _i, noise) => {
     const freq = 34 + 135 * Math.exp(-t * 2.1);
     phase += (2 * Math.PI * freq) / SAMPLE_RATE;
     const env = Math.min(1, t * 40) * Math.exp(-t * 1.15);
     const punch = t < 0.08 ? noise() * (1 - t / 0.08) * 0.35 : 0;
     const body = Math.tanh((Math.sin(phase) + 0.32 * Math.sin(phase * 2)) * 1.65) * env * 0.92;
     return [body + punch, body - punch * 0.5];
    });
  }

  case 'sadtrombone': {
   let phase = 0;
   return createStereoWav(2.45, t => {
     let freq = 0;
     let localT = 0;
     let noteDur = 0.42;
     if (t < 0.42) { freq = 293.66; localT = t; }
     else if (t < 0.84) { freq = 277.18; localT = t - 0.42; }
     else if (t < 1.26) { freq = 261.63; localT = t - 0.84; }
     else {
      localT = t - 1.26;
      noteDur = 1.18;
      // Nốt cuối tụt cao độ + rung wah-wah
      freq = (246.94 - localT * 18) * (1 + 0.018 * Math.sin(2 * Math.PI * 6.2 * localT));
     }
     phase += (2 * Math.PI * freq) / SAMPLE_RATE;
     const wah = 0.55 + 0.45 * Math.sin(Math.PI * Math.min(1, localT / Math.min(0.38, noteDur)));
     const env = Math.min(1, localT * 35) * Math.max(0, 1 - (localT / noteDur) * 0.55);
     const brass =
      (Math.sin(phase) * 0.52 +
       Math.sin(phase * 2) * 0.28 * wah +
       Math.sin(phase * 3) * 0.16 * wah +
       Math.sin(phase * 4) * 0.08 * wah) * env * 0.82;
     return [brass, brass * 0.96];
    });
  }

  case 'winxp': {
   // Hợp âm 4 nốt kinh điển Eb5 - Bb4 - Ab4 - Eb5 ấm áp
   const notes = [
    { start: 0.0, f: 830.61 },
    { start: 0.34, f: 622.25 },
    { start: 0.68, f: 415.3 },
    { start: 1.04, f: 466.16 },
   ];
   return createStereoWav(2.3, t => {
     let l = 0, r = 0;
     for (const n of notes) {
      if (t < n.start) continue;
      const dt = t - n.start;
      const env = Math.min(1, dt * 45) * Math.exp(-dt * 2.4);
      const tone =
       Math.sin(2 * Math.PI * n.f * dt) * 0.65 +
       Math.sin(2 * Math.PI * (n.f * 2) * dt) * 0.22 +
       Math.sin(2 * Math.PI * (n.f * 0.5) * dt) * 0.18;
      l += tone * env * 0.45;
      r += tone * env * 0.48;
     }
     return [l, r];
    });
  }

  case 'applause':
   return createStereoWav(2.3, (t, _i, noise) => {
     // Tiếng kèn Fanfare ngắn (C5 - E5 - G5 - C6) + pháo tay rộn ràng
     let horn = 0;
     const fanfare = [
      [0.0, 0.14, 523.25],
      [0.14, 0.28, 659.25],
      [0.28, 0.42, 783.99],
      [0.42, 0.95, 1046.5],
     ];
     for (const [s, e, f] of fanfare) {
      if (t >= s && t < e) {
       const dt = t - s;
       const env = Math.exp(-dt * 2.5);
       horn += (Math.sin(2 * Math.PI * f * dt) * 0.6 + Math.sin(2 * Math.PI * f * 2 * dt) * 0.25) * env * 0.52;
      }
     }
     const clapEnv = Math.min(1, t * 5) * Math.max(0, 1 - Math.max(0, t - 1.4) / 0.9);
     const burstL = Math.pow(Math.max(0, Math.sin(2 * Math.PI * 11.5 * t + 0.3)), 4);
     const burstR = Math.pow(Math.max(0, Math.sin(2 * Math.PI * 12.7 * t + 1.4)), 4);
     const clapL = noise() * (0.28 + 0.55 * burstL) * clapEnv * 0.55;
     const clapR = noise() * (0.28 + 0.55 * burstR) * clapEnv * 0.55;
     return [horn + clapL, horn + clapR];
    });

  case 'beep':
  default:
   return createStereoWav(0.85, t => {
     const fade = t < 0.02 ? t / 0.02 : t > 0.82 ? (0.85 - t) / 0.03 : 1;
     const s = Math.sin(2 * Math.PI * 1000 * t) * 0.72 * fade;
     return [s, s];
    });
 }
}

export function synthesizeSfxWav(effectId) {
 const spec = SFX_PRESETS[effectId];
 if (!spec) throw new Error('Không tìm thấy hiệu ứng âm thanh này.');
 const buffer = renderEffectBuffer(effectId);
 return { ...spec, preset: spec, buffer };
}
