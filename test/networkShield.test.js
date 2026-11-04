import assert from 'node:assert/strict';
import test from 'node:test';
import util from 'node:util';
import {
 createResilientDnsLookup,
 isRecoverableNetworkOrStreamError,
} from '../src/networkShield.js';

test('Resilient DNS Shield caches IPs, deduplicates concurrent lookups, and survives EAI_AGAIN via stale cache & 1.1.1.1 failover', async () => {
 let osCalls = 0;
 let failOsWithEaiAgain = false;

 const mockBaseLookup = (host, _opts, cb) => {
  osCalls++;
  setTimeout(() => {
   if (failOsWithEaiAgain) {
    const err = Object.assign(new Error(`getaddrinfo EAI_AGAIN ${host}`), { code: 'EAI_AGAIN' });
    cb(err);
    return;
   }
   cb(null, [{ address: '162.159.135.232', family: 4 }]);
  }, 5);
 };

 let publicCalls = 0;
 const mockPublicResolverFactory = () => ({
  resolve4(host, cb) {
   publicCalls++;
   if (host === 'cold-outage.discord.gg') {
    cb(null, ['162.159.136.234']);
   } else {
    cb(Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }));
   }
  },
  resolve6(_host, cb) {
   cb(Object.assign(new Error('ENODATA'), { code: 'ENODATA' }));
  },
 });

 const shield = createResilientDnsLookup({
  baseLookup: mockBaseLookup,
  publicResolverFactory: mockPublicResolverFactory,
  freshTtlMs: 30,
  staleTtlMs: 60_000,
 });
 const lookupAsync = util.promisify(shield.lookup);

 // 1. Gộp các truy vấn đồng thời vào đúng 1 lần gọi OS DNS (tránh nghẽn luồng libuv)
 const [r1, r2] = await Promise.all([
  lookupAsync('gateway.discord.gg', { all: true }),
  lookupAsync('gateway.discord.gg'),
 ]);
 assert.equal(osCalls, 1);
 assert.deepEqual(r1, [{ address: '162.159.135.232', family: 4 }]);
 assert.deepEqual(r2, { address: '162.159.135.232', family: 4 });

 // 2. Khi cache hết hạn tươi (freshTtlMs=30ms) VÀ máy chủ botkeep bị sập DNS EAI_AGAIN -> tự trả IP dự phòng trong RAM, Bot không rớt mạng!
 await new Promise(r => setTimeout(r, 45));
 failOsWithEaiAgain = true;
 const staleRecovered = await lookupAsync('gateway.discord.gg', { all: true });
 assert.deepEqual(staleRecovered, [{ address: '162.159.135.232', family: 4 }]);
 assert.equal(publicCalls, 0, 'Stale cache should rescue immediately without needing external UDP query');

 // 3. Tên miền chưa từng có trong cache lúc OS DNS đang EAI_AGAIN -> tự nhảy sang hỏi DNS 1.1.1.1 / 8.8.8.8!
 const publicRecovered = await lookupAsync('cold-outage.discord.gg', { all: true });
 assert.deepEqual(publicRecovered, [{ address: '162.159.136.234', family: 4 }]);
 assert.equal(publicCalls, 1);
});

test('isRecoverableNetworkOrStreamError catches Node 22 fetch TypeError(cause=EAI_AGAIN) & Happy Eyeballs AggregateError without masking real code bugs', () => {
 const wrappedFetchEaiAgain = new TypeError('fetch failed', {
  cause: Object.assign(new Error('getaddrinfo EAI_AGAIN bot-dis-2.botmusicvip.workers.dev'), {
   code: 'EAI_AGAIN',
  }),
 });
 assert.equal(isRecoverableNetworkOrStreamError(wrappedFetchEaiAgain), true);

 const happyEyeballsTimeout = new AggregateError([
  Object.assign(new Error('connect ETIMEDOUT 162.159.130.233:443'), { code: 'ETIMEDOUT' }),
  Object.assign(new Error('connect ENETUNREACH 2606:4700::1:443'), { code: 'ENETUNREACH' }),
 ], 'AggregateError');
 assert.equal(isRecoverableNetworkOrStreamError(happyEyeballsTimeout), true);

 // Lỗi lập trình thật sự vẫn phải trả về false để không bị che giấu
 assert.equal(isRecoverableNetworkOrStreamError(new ReferenceError('x is not defined')), false);
 assert.equal(isRecoverableNetworkOrStreamError(new TypeError('Cannot read properties of null')), false);
});

test('createResilientDnsLookup sorts IPv4 ahead of IPv6 for family=0 to prevent YouTube IP-mismatch 403', async () => {
 const mockBaseLookup = (_host, _opts, cb) => {
  cb(null, [
   { address: '2a01:4f8:c17:1234::1', family: 6 },
   { address: '142.250.199.14', family: 4 },
  ]);
 };
 const { lookup } = createResilientDnsLookup({ baseLookup: mockBaseLookup });
 const lookupAsync = util.promisify(lookup);

 const single = await lookupAsync('www.youtube.com');
 assert.equal(single.address, '142.250.199.14');
 assert.equal(single.family, 4);

 const all = await lookupAsync('www.youtube.com', { all: true });
 assert.equal(all[0].family, 4);
 assert.equal(all[1].family, 6);
});

