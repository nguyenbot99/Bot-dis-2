import 'dotenv/config';
import { REST, Routes } from 'discord.js';
import { commands } from '../src/commands.js';
import { resolveConfig } from '../src/policy.js';

// Kịch bản đăng ký thủ công các lệnh slash (tên lệnh giữ tiếng Anh, chú thích tiếng Việt).
const { token, guildId } = resolveConfig(process.env);
const rest = new REST({ version: '10' }).setToken(token);
const clientId = (process.env.CLIENT_ID ?? '').trim() || (await rest.get(Routes.oauth2CurrentApplication())).id;
const route = guildId ? Routes.applicationGuildCommands(clientId, guildId) : Routes.applicationCommands(clientId);
await rest.put(route, { body: commands });
console.log(guildId ? `Đã đăng ký ${commands.length} lệnh cho guild ${guildId}.` : `Đã đăng ký ${commands.length} lệnh global.`);
