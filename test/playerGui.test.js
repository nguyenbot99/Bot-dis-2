import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MessageFlags } from 'discord.js';
import {
 buildAddSongModal,
 buildEndedPayload,
 buildNowPlayingEmbed,
 buildPlayerPayload,
 buildQueueEmbed,
 formatDuration,
 safeHttpUrl,
} from '../src/playerGui.js';

const sampleTrack = {
 title: 'Night Lights @everyone',
 url: 'https://soundcloud.com/miraie/night-lights',
 duration: 236000,
 thumbnail: 'https://i1.sndcdn.com/artworks-abc-large.jpg',
 requestedBy: '123456789012345678',
 source: 'soundcloud',
 metadata: { author: 'Miraie' },
};

const samplePlayer = {
 isPaused: false,
 volume: 80,
 loop: () => 'off',
 queue: { currentTrack: sampleTrack },
 currentTrack: sampleTrack,
 previousTrack: null,
 upcomingTracks: [
  { title: 'Lost Sky', duration: 210000, requestedBy: '123456789012345678' },
 ],
 userdata: { ownerId: '123456789012345678', voiceChannelId: '987654321098765432' },
 getProgressBar: () => '0:42 ▬▬▬▬🔘▬▬▬▬▬▬▬▬▬▬▬ 3:56',
};

test('buildPlayerPayload generates valid Components V2 container with artwork and controls', () => {
 const payload = buildPlayerPayload(samplePlayer);
 assert.equal(payload.flags, MessageFlags.IsComponentsV2);
 assert.equal(payload.components.length, 1);
 const json = payload.components[0].toJSON();
 assert.equal(json.type, 17);
 assert.equal(json.accent_color, 0x7c4dff);
 const raw = JSON.stringify(json);
 assert.ok(raw.includes('-t500x500.jpg'), 'upgrades SoundCloud artwork resolution');
 assert.ok(!raw.includes('@everyone'), 'strips mention tokens from title');
 assert.ok(raw.includes('player_menu'));
 assert.ok(raw.includes('player_pause'));
});

test('buildPlayerPayload handles missing URL/thumbnail and paused state gracefully', () => {
 const minimalPlayer = {
  isPaused: true,
  volume: 50,
  loop: () => 'track',
  queue: { currentTrack: { title: 'Test', url: 'javascript:alert(1)', thumbnail: 'invalid', duration: 0 } },
  previousTrack: sampleTrack,
  upcomingTracks: [],
  userdata: {},
 };
 const json = buildPlayerPayload(minimalPlayer).components[0].toJSON();
 assert.equal(json.accent_color, 0xfee75c);
 assert.ok(!JSON.stringify(json).includes('javascript:'));
});

test('buildEndedPayload, modal, and embeds serialize cleanly', () => {
 const ended = buildEndedPayload('Đã dừng.');
 assert.equal(ended.flags, MessageFlags.IsComponentsV2);
 assert.equal(ended.components[0].toJSON().type, 17);

 const modal = buildAddSongModal().toJSON();
 assert.equal(modal.custom_id, 'player_add_modal');

 const botUser = { username: 'Bắt_Don', displayAvatarURL: () => 'https://cdn.discordapp.com/embed/avatars/0.png' };
 const qEmbed = buildQueueEmbed(samplePlayer, botUser).toJSON();
 const npEmbed = buildNowPlayingEmbed(samplePlayer, botUser).toJSON();
 assert.ok(qEmbed.description.includes('Lost Sky'));
 assert.ok(npEmbed.title.includes('Night Lights'));
 assert.equal(formatDuration(236000), '3:56');
 assert.equal(safeHttpUrl('ftp://bad'), null);
});
