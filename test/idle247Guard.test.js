import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createIdle247RecoveryPolicy, IDLE_247_CHECK_MS } from '../src/idle247Guard.js';

test('24/7 rảnh: chờ mất kết nối bền vững rồi mới yêu cầu nối lại', () => {
 const guard = createIdle247RecoveryPolicy();
 assert.equal(IDLE_247_CHECK_MS, 20000);
 assert.equal(guard.check('guild', { active: true, healthy: true, now: 1000 }), 'healthy');
 assert.equal(guard.check('guild', { active: true, healthy: false, now: 2000 }), 'wait');
 assert.equal(guard.check('guild', { active: true, healthy: false, now: 21000 }), 'wait');
 assert.equal(guard.check('guild', { active: true, healthy: false, now: 42000 }), 'reconnect');
 assert.equal(guard.check('guild', { active: true, healthy: false, now: 62000 }), 'wait');
 assert.equal(guard.check('guild', { active: true, healthy: false, now: 82000 }), 'reconnect');
 assert.equal(guard.check('guild', { active: true, healthy: false, now: 122000 }), 'limit');
});

test('không kiểm tra khi tắt 24/7 / đang phát và giữ giới hạn khi vừa nối lại', () => {
 const guard = createIdle247RecoveryPolicy();
 assert.equal(guard.check('guild', { active: true, healthy: false, now: 1000 }), 'wait');
 assert.equal(guard.check('guild', { active: false, healthy: false, now: 40000 }), 'none');
 assert.equal(guard.check('guild', { active: true, healthy: false, now: 60000 }), 'wait');
 assert.equal(guard.check('guild', { active: true, healthy: false, now: 100000 }), 'reconnect');
 assert.equal(guard.check('guild', { active: true, healthy: true, now: 110000 }), 'healthy');
 assert.equal(guard.check('guild', { active: true, healthy: false, now: 120000 }), 'wait');
 assert.equal(guard.check('guild', { active: true, healthy: false, now: 160000 }), 'reconnect');
 assert.equal(guard.check('guild', { active: true, healthy: false, now: 200000 }), 'limit');
 assert.equal(guard.check('guild', { active: true, healthy: false, now: 760001 }), 'reconnect');
});
