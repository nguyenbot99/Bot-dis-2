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
