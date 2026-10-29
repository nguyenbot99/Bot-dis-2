// Bộ hẹn giờ tắt nhạc đi ngủ êm ái: tự động giảm dần âm lượng (fade-out) ở những giây cuối trước khi dừng để không làm giật mình người nghe.

export function createSleepTimerManager({
 getPlayer: defaultGetPlayer = null,
 onTriggerStop = null,
 onExecuteStop = null,
 fadeSteps = 12,
 fadeStepMs = 1000,
} = {}) {
 const timers = new Map(); // guildId -> { mode: 'timer'|'after_track', minutes, endAtMs, leaveVoice, getPlayer, timeout, fading, originalVolume }

 function resolveGuildPlayer(entry, guildId) {
  if (typeof entry?.getPlayer === 'function') return entry.getPlayer(guildId);
  if (typeof defaultGetPlayer === 'function') return defaultGetPlayer(guildId);
  return null;
 }

 function clearEntry(guildId) {
  const existing = timers.get(guildId);
  if (!existing) return false;
  if (existing.timeout) clearTimeout(existing.timeout);
  timers.delete(guildId);
  // Nếu hủy hẹn giờ đúng lúc đang giảm âm lượng dở, khôi phục lại mức âm lượng ban đầu
  if (existing.fading && typeof existing.originalVolume === 'number') {
   const pl = resolveGuildPlayer(existing, guildId);
   if (pl && !pl.destroyed && typeof pl.setVolume === 'function') {
    try { pl.setVolume(existing.originalVolume); } catch {}
   }
  }
  return true;
 }

 async function triggerSleepStop(guildId, { skipFade = false } = {}) {
  const entry = timers.get(guildId);
  if (!entry || entry.fading) return;
  entry.fading = true;
  if (entry.timeout) {
   clearTimeout(entry.timeout);
   entry.timeout = null;
  }

  const mode = entry.mode;
  const leaveVoice = Boolean(entry.leaveVoice);
  const player = resolveGuildPlayer(entry, guildId);
  const originalVolume = Number(player?.volume ?? 100);
  entry.originalVolume = originalVolume;

  try {
   if (
    !skipFade &&
    fadeSteps > 0 &&
    player &&
    !player.destroyed &&
    !player.isPaused &&
    (player.queue?.currentTrack || player.currentTrack) &&
    typeof player.setVolume === 'function'
   ) {
    for (let step = fadeSteps - 1; step >= 1; step--) {
     if (!timers.has(guildId) || player.destroyed) return;
     const nextVol = Math.max(1, Math.round((originalVolume * step) / fadeSteps));
     try { player.setVolume(nextVol); } catch {}
     await new Promise(r => {
      const t = setTimeout(r, fadeStepMs);
      t.unref?.();
     });
    }
   }
  } finally {
   const stillActive = timers.has(guildId);
   timers.delete(guildId);
   if (stillActive) {
    const latestPlayer = resolveGuildPlayer(entry, guildId) ?? player;
    if (typeof onTriggerStop === 'function') {
     await onTriggerStop({ guildId, player: latestPlayer, leaveVoice, mode, originalVolume });
    } else if (typeof onExecuteStop === 'function') {
     await onExecuteStop(guildId, { leaveVoice, originalVolume, mode });
    }
   }
  }
 }

 function setMinutes(guildId, minutes, { leaveVoice = false, getPlayer = null } = {}) {
  const cleanMin = Math.round(Number(minutes));
  if (!Number.isFinite(cleanMin) || cleanMin < 1 || cleanMin > 180) {
   throw new Error('Số phút hẹn giờ đi ngủ phải từ 1 đến 180 phút (hoặc nhập 0 để hủy).');
  }
  clearEntry(guildId);
  const totalMs = cleanMin * 60_000;
  const fadeTotalMs = Math.max(0, (fadeSteps - 1) * fadeStepMs);
  const waitBeforeFadeMs = Math.max(0, totalMs - fadeTotalMs);
  const endAtMs = Date.now() + totalMs;

  const timeout = setTimeout(() => {
   void triggerSleepStop(guildId, { skipFade: totalMs <= fadeTotalMs });
  }, waitBeforeFadeMs);
  timeout.unref?.();

  const entry = {
   mode: 'timer',
   minutes: cleanMin,
   endAtMs,
   endsAtMs: endAtMs,
   leaveVoice: Boolean(leaveVoice),
   getPlayer,
   timeout,
   fading: false,
   originalVolume: null,
  };
  timers.set(guildId, entry);
  return entry;
 }

 function setAfterCurrentTrack(guildId, { leaveVoice = false, getPlayer = null } = {}) {
  clearEntry(guildId);
  const entry = {
   mode: 'after_track',
   minutes: null,
   endAtMs: null,
   endsAtMs: null,
   leaveVoice: Boolean(leaveVoice),
   getPlayer,
   timeout: null,
   fading: false,
   originalVolume: null,
  };
  timers.set(guildId, entry);
  return entry;
 }

 function notifyTrackEnded(guildId) {
  const entry = timers.get(guildId);
  if (!entry || entry.mode !== 'after_track' || entry.fading) return false;
  void triggerSleepStop(guildId, { skipFade: true });
  return true;
 }

 function getStatus(guildId) {
  const entry = timers.get(guildId);
  if (!entry) return null;
  return {
   mode: entry.mode,
   minutes: entry.minutes,
   endAtMs: entry.endAtMs,
   endsAtMs: entry.endAtMs,
   leaveVoice: entry.leaveVoice,
   remainingMs: entry.endAtMs ? Math.max(0, entry.endAtMs - Date.now()) : null,
  };
 }

 return {
  setMinutes,
  setAfterCurrentTrack,
  notifyTrackEnded,
  cancel: clearEntry,
  getStatus,
 };
}
