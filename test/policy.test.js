import {test} from 'node:test';
import assert from 'node:assert/strict';
import {validateQuery} from '../src/policy.js';
import {commands} from '../src/commands.js';
test('valid search and source URL',()=>{
 assert.equal(validateQuery(' hello '),'hello');
 assert.equal(validateQuery('https://youtu.be/abc'),'https://youtu.be/abc');
});
test('reject dangerous URLs and playlists',()=>{
 for(const q of ['http://127.0.0.1','file:///etc/passwd','https://youtube.com.evil.org/x','https://youtube.com/playlist?list=x','https://soundcloud.com/a/sets/b','','x'.repeat(201)]) assert.throws(()=>validateQuery(q));
});
test('unique guild-only commands',()=>{
 assert.equal(new Set(commands.map(c=>c.name)).size,8);
 assert.ok(commands.every(c=>c.dm_permission===false));
});
