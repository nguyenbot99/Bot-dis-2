import 'dotenv/config';
import { REST, Routes } from 'discord.js';
import { commands, dmCommands } from '../src/commands.js';
import { resolveConfig } from '../src/policy.js';

// Kịch bản đăng ký thủ công các lệnh slash cho máy chủ + lệnh /announce riêng trong DM của Bot.
const { token, guildId } = resolveConfig(process.env);
const rest = new REST({ version: '10' }).setToken(token);
const clientId = (process.env.CLIENT_ID ?? '').trim() || (await rest.get(Routes.oauth2CurrentApplication())).id;

// Đăng ký lệnh BotDM (/announce trong hộp thư riêng của Bot, không hiện trùng ngoài Server).
await rest.put(Routes.applicationCommands(clientId), { body: dmCommands });

if (guildId) {
 await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commands });
 console.log(`Đã đăng ký ${commands.length} lệnh cho guild ${guildId} và ${dmCommands.length} lệnh DM.`);
} else {
 const guilds = await rest.get(Routes.userGuilds());
 const targets = (Array.isArray(guilds) ? guilds : []).slice(0, 5);
 await Promise.all(targets.map(g => rest.put(Routes.applicationGuildCommands(clientId, g.id), { body: commands })));
 console.log(`Đã đăng ký ${commands.length} lệnh cho ${targets.length} máy chủ và ${dmCommands.length} lệnh DM.`);
}
