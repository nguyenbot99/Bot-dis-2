import dns from 'node:dns';
import net from 'node:net';
import util from 'node:util';

// Bộ đệm DNS siêu nhẹ (~8 KB RAM) + tự động dùng bản ghi dự phòng khi DNS nội bộ của VPS (botkeep.cloud) bị lỗi EAI_AGAIN / nghẽn mạng.
const FRESH_TTL_MS = 3 * 60 * 1000; // 3 phút dùng trực tiếp từ RAM (0ms, không tốn luồng libuv)
const STALE_ON_ERROR_TTL_MS = 2 * 60 * 60 * 1000; // Giữ bản ghi dự phòng tối đa 2 giờ để cứu Bot khi DNS máy chủ sập tạm thời
const MAX_DNS_CACHE_ENTRIES = 80;
const PUBLIC_FALLBACK_SERVERS = ['1.1.1.1', '8.8.8.8', '1.0.0.1', '8.8.4.4'];

const TRANSIENT_DNS_CODES = new Set([
 'EAI_AGAIN',
 'ETIMEOUT',
 'ETIMEDOUT',
 'ESERVFAIL',
 'EREFUSED',
 'ECONNREFUSED',
]);

// Danh sách mã lỗi mạng / luồng âm thanh thoáng qua (kể cả lỗi bọc bên trong TypeError: fetch failed -> err.cause hoặc AggregateError của Node 22).
export const RECOVERABLE_NETWORK_CODES = new Set([
 'ECONNRESET',
 'EPIPE',
 'ETIMEDOUT',
 'ETIMEOUT',
 'ECONNABORTED',
 'EHOSTUNREACH',
 'ENETUNREACH',
 'EAI_AGAIN',
 'ENOTFOUND',
 'ESERVFAIL',
 'ECONNREFUSED',
 'ERR_STREAM_PREMATURE_CLOSE',
 'ERR_STREAM_DESTROYED',
 'ERR_STREAM_WRITE_AFTER_END',
 'UND_ERR_CONNECT_TIMEOUT',
 'UND_ERR_HEADERS_TIMEOUT',
 'UND_ERR_BODY_TIMEOUT',
 'UND_ERR_SOCKET',
 'UND_ERR_ABORTED',
 'ABORT_ERR',
]);

const RECOVERABLE_ERROR_NAMES = new Set([
 'AbortError',
 'TimeoutError',
 'DiscordAPIError',
 'HTTPError',
 'RateLimitError',
 'SocketError',
 'ConnectTimeoutError',
 'HeadersTimeoutError',
 'BodyTimeoutError',
]);

// Đệ quy kiểm tra cả err, err.cause (chuẩn fetch/undici Node 22) và err.errors (AggregateError của Happy Eyeballs IPv4/IPv6).
export function isRecoverableNetworkOrStreamError(err, depth = 0) {
 if (!err || depth > 5) return depth === 0;
 const code = String(err?.code ?? '');
 const name = String(err?.name ?? '');
 const msg = String(err?.message ?? '');

 if (RECOVERABLE_NETWORK_CODES.has(code) || RECOVERABLE_NETWORK_CODES.has(name)) return true;
 if (RECOVERABLE_ERROR_NAMES.has(name)) return true;

 if (/^(fetch failed|terminated|aborted|socket hang up|read ECONNRESET|write EPIPE)/i.test(msg)) {
  if (!err.cause) return true;
 }
 if (/\b(EAI_AGAIN|ETIMEDOUT|ECONNRESET|UND_ERR_|WebSocket was closed)\b/.test(msg)) {
  return true;
 }

 if (err.cause && isRecoverableNetworkOrStreamError(err.cause, depth + 1)) {
  return true;
 }
 if (Array.isArray(err.errors) && err.errors.length > 0) {
  return err.errors.every(sub => isRecoverableNetworkOrStreamError(sub, depth + 1));
 }
 return false;
}

export function createResilientDnsLookup({
 baseLookup = dns.lookup.bind(dns),
 publicResolverFactory = () => {
  const r = new dns.Resolver({ timeout: 2200, tries: 2 });
  r.setServers(PUBLIC_FALLBACK_SERVERS);
  return r;
 },
 freshTtlMs = FRESH_TTL_MS,
 staleTtlMs = STALE_ON_ERROR_TTL_MS,
} = {}) {
 const cache = new Map();
 const inflight = new Map();
 let publicResolver = null;

 function getPublicResolver() {
  if (!publicResolver) {
   try {
    publicResolver = publicResolverFactory();
   } catch {
    publicResolver = null;
   }
  }
  return publicResolver;
 }

 function saveCache(cacheKey, records) {
  if (!Array.isArray(records) || records.length === 0) return;
  const now = Date.now();
  while (cache.size >= MAX_DNS_CACHE_ENTRIES && !cache.has(cacheKey)) {
   const oldest = cache.keys().next().value;
   if (!oldest) break;
   cache.delete(oldest);
  }
  cache.set(cacheKey, {
   records,
   expiresAt: now + freshTtlMs,
   staleUntil: now + staleTtlMs,
  });
 }

 function deliver(records, wantAll, cb) {
  queueMicrotask(() => {
   if (wantAll) {
    cb(null, records.map(r => ({ address: r.address, family: r.family })));
   } else {
    cb(null, records[0].address, records[0].family);
   }
  });
 }

 function resolveViaPublicDns(host, familyNum) {
  const resolver = getPublicResolver();
  if (!resolver) return Promise.resolve(null);

  return new Promise(resolve => {
   const wantV4 = familyNum === 0 || familyNum === 4;
   const wantV6 = familyNum === 6;

   if (wantV6) {
    resolver.resolve6(host, (err, ips) => {
     if (err || !Array.isArray(ips) || ips.length === 0) return resolve(null);
     resolve(ips.map(address => ({ address, family: 6 })));
    });
    return;
   }
   if (wantV4) {
    resolver.resolve4(host, (err, ips) => {
     if (!err && Array.isArray(ips) && ips.length > 0) {
      resolve(ips.map(address => ({ address, family: 4 })));
      return;
     }
     if (familyNum === 0) {
      resolver.resolve6(host, (err6, ips6) => {
       if (err6 || !Array.isArray(ips6) || ips6.length === 0) return resolve(null);
       resolve(ips6.map(address => ({ address, family: 6 })));
      });
      return;
     }
     resolve(null);
    });
   }
  });
 }

 function lookup(hostname, options, callback) {
  let opts = options;
  let cb = callback;
  if (typeof opts === 'function') {
   cb = opts;
   opts = {};
  } else if (typeof opts === 'number') {
   opts = { family: opts };
  } else if (!opts || typeof opts !== 'object') {
   opts = {};
  }

  if (typeof cb !== 'function') {
   return baseLookup(hostname, options, callback);
  }

  const rawHost = typeof hostname === 'string' ? hostname.trim() : '';
  if (
   !rawHost
   || net.isIP(rawHost) !== 0
   || rawHost === 'localhost'
   || rawHost.endsWith('.localhost')
   || rawHost.endsWith('.local')
  ) {
   return baseLookup(hostname, opts, cb);
  }

  const wantAll = Boolean(opts.all);
  const rawFamily = opts.family === 'IPv4' ? 4 : (opts.family === 'IPv6' ? 6 : (Number(opts.family) || 0));
  const familyNum = rawFamily === 4 || rawFamily === 6 ? rawFamily : 0;
  const hostKey = `${rawHost.toLowerCase()}|${familyNum}`;
  const now = Date.now();
  const cached = cache.get(hostKey);

  if (cached && now < cached.expiresAt) {
   deliver(cached.records, wantAll, cb);
   return;
  }

  let waiters = inflight.get(hostKey);
  if (waiters) {
   waiters.push({ wantAll, cb });
   return;
  }

  waiters = [{ wantAll, cb }];
  inflight.set(hostKey, waiters);

  const finishAll = (err, records) => {
   inflight.delete(hostKey);
   for (const w of waiters) {
    if (err || !records?.length) {
     queueMicrotask(() => w.cb(err || new Error(`ENOTFOUND ${rawHost}`)));
    } else {
     deliver(records, w.wantAll, w.cb);
    }
   }
  };

  baseLookup(
   rawHost,
   { ...opts, all: true, family: familyNum },
   async (err, res) => {
    if (!err && Array.isArray(res) && res.length > 0) {
     const normalized = res
      .filter(r => r && typeof r.address === 'string')
      .map(r => ({ address: r.address, family: r.family || (net.isIP(r.address) === 6 ? 6 : 4) }));
     if (normalized.length > 0) {
      saveCache(hostKey, normalized);
      finishAll(null, normalized);
      return;
     }
    }

    const code = String(err?.code ?? '');
    if (TRANSIENT_DNS_CODES.has(code)) {
     // 1. Ưu tiên dùng ngay IP đã lưu gần đây trong RAM để Discord Gateway & Cloudflare không bị đứt kết nối!
     const stale = cache.get(hostKey);
     if (stale && Date.now() < stale.staleUntil && stale.records.length > 0) {
      finishAll(null, stale.records);
      return;
     }
     // 2. Nếu chưa có cache, hỏi thẳng DNS 1.1.1.1 / 8.8.8.8 để vượt qua DNS nội bộ bị kẹt của container.
     const fallbackRecords = await resolveViaPublicDns(rawHost, familyNum);
     if (fallbackRecords && fallbackRecords.length > 0) {
      saveCache(hostKey, fallbackRecords);
      finishAll(null, fallbackRecords);
      return;
     }
    }

    finishAll(err, null);
   },
  );
 }

 lookup[util.promisify.custom] = (hostname, options) => new Promise((resolve, reject) => {
  const hasOpts = options !== undefined;
  const wantAll = typeof options === 'object' && options !== null && Boolean(options.all);
  const done = (err, addressOrList, family) => {
   if (err) return reject(err);
   if (wantAll) return resolve(addressOrList);
   resolve({ address: addressOrList, family });
  };
  if (hasOpts) lookup(hostname, options, done);
  else lookup(hostname, done);
 });

 return {
  lookup,
  getCacheSize: () => cache.size,
  clearCache: () => cache.clear(),
 };
}

let shieldInstalled = false;

export function installResilientDnsShield() {
 if (shieldInstalled) return;
 shieldInstalled = true;
 const { lookup } = createResilientDnsLookup({ baseLookup: dns.lookup.bind(dns) });
 dns.lookup = lookup;
}
