import {test} from 'node:test';
import assert from 'node:assert/strict';
import {resolveConfig,validateQuery} from '../src/policy.js';
import {commands,helpMessage} from '../src/commands.js';
test('valid search and source URL',()=>{
 assert.equal(validateQuery(' hello '),'hello');
 assert.equal(validateQuery('https://youtu.be/abc'),'https://youtu.be/abc');
});
test('reject dangerous URLs and playlists',()=>{
 for(const q of ['http://127.0.0.1','file:///etc/passwd','https://youtube.com.evil.org/x','https://youtube.com/playlist?list=x','https://soundcloud.com/a/sets/b','','x'.repeat(201)]) assert.throws(()=>validateQuery(q));
});
test('resolveConfig works with DISCORD_TOKEN only and optional GUILD_ID',()=>{
 assert.deepEqual(resolveConfig({DISCORD_TOKEN:' "abc.def" '}),{token:'abc.def',guildId:null,autoRegister:true});
 assert.deepEqual(resolveConfig({BOT_TOKEN:'xyz',GUILD_ID:'123456789012345678',AUTO_REGISTER:'false'}),{token:'xyz',guildId:'123456789012345678',autoRegister:false});
 assert.throws(()=>resolveConfig({}),/Thiếu DISCORD_TOKEN/);
 assert.throws(()=>resolveConfig({DISCORD_TOKEN:'abc',GUILD_ID:'ten-server'}),/GUILD_ID không hợp lệ/);
});
test('unique guild-only commands and bounded help message',()=>{
 assert.equal(new Set(commands.map(c=>c.name)).size,13);
 assert.ok(commands.every(c=>c.dm_permission===false));
 assert.ok(helpMessage.length>0 && helpMessage.length<=2000);
 for(const c of commands) assert.ok(helpMessage.includes(`/${c.name}`),`missing /${c.name} in helpMessage`);
});
test('new music command options are bounded',()=>{
 const option=name=>commands.find(c=>c.name===name).options[0];
 assert.deepEqual(option('loop').choices.map(c=>c.value),['off','track','queue']);
 assert.equal(option('volume').min_value,0);
 assert.equal(option('volume').max_value,100);
 assert.equal(option('remove').min_value,1);
 assert.equal(option('remove').max_value,20);
});
