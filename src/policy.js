export function resolveConfig(env = process.env) {
 const rawToken = env.DISCORD_TOKEN || env.BOT_TOKEN || env.DISCORD_BOT_TOKEN || env.TOKEN || '';
 const token = String(rawToken).trim().replace(/^(['"])(.*)\1$/, '$2').trim();
 if (!token) throw new Error('Thiếu DISCORD_TOKEN trong biến môi trường.');

 const rawGuildId = String(env.GUILD_ID ?? '').trim();
 if (rawGuildId && !/^\d{17,20}$/.test(rawGuildId)) {
  throw new Error('GUILD_ID không hợp lệ (cần 17–20 chữ số, hoặc để trống).');
 }

 const autoRegister = !['false', '0'].includes(String(env.AUTO_REGISTER ?? 'true').trim().toLowerCase());
 return { token, guildId: rawGuildId || null, autoRegister };
}

export function validateQuery(input) {
 const q = input.trim();
 if (!q || q.length > 200) throw new Error('Tên bài phải dài 1–200 ký tự.');
 if (/^[a-z][a-z0-9+.-]*:/i.test(q)) {
  let u;
  try { u = new URL(q); } catch { throw new Error('URL không hợp lệ.'); }
  const hosts = ['youtube.com','www.youtube.com','music.youtube.com','youtu.be','soundcloud.com','www.soundcloud.com'];
  if(u.protocol !== 'https:' || !hosts.includes(u.hostname) || u.username || u.password || u.port) throw new Error('Chỉ nhận URL HTTPS YouTube/SoundCloud.');
  if(u.searchParams.has('list') || /\/playlist|\/sets\//i.test(u.pathname)) throw new Error('Bản tiết kiệm RAM không nhận playlist.');
 }
 return q;
}
