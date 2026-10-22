import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertMusicAccess } from '../src/access.js';
const mutations=['play','pause','resume','skip','stop','loop','shuffle','volume','remove'];
const player={queue:{currentTrack:{requestedBy:'alice'}},userdata:{ownerId:'creator'}};
test('only current track requester may mutate music',()=>{
 for(const command of mutations){
  assert.doesNotThrow(()=>assertMusicAccess(command,'alice',player));
  assert.throws(()=>assertMusicAccess(command,'bob',player),/Bạn không có quyền/);
  assert.throws(()=>assertMusicAccess(command,'creator',player));
 }
});
test('read-only commands stay public',()=>{
 for(const command of ['queue','nowplaying','ping']) assert.doesNotThrow(()=>assertMusicAccess(command,'bob',player));
});
test('ownership follows next track',()=>{
 const next={...player,queue:{currentTrack:{requestedBy:'bob'}}};
 assert.doesNotThrow(()=>assertMusicAccess('skip','bob',next));
 assert.throws(()=>assertMusicAccess('skip','alice',next));
});
test('gaps use previous requester, then session creator; unknown owner denied',()=>{
 assert.doesNotThrow(()=>assertMusicAccess('stop','alice',{queue:{},previousTrack:{requestedBy:'alice'}}));
 assert.doesNotThrow(()=>assertMusicAccess('play','creator',{queue:{},userdata:{ownerId:'creator'}}));
 assert.throws(()=>assertMusicAccess('stop','bob',{queue:{}}));
 assert.doesNotThrow(()=>assertMusicAccess('play','bob',undefined));
});
