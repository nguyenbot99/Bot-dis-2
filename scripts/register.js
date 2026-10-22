import 'dotenv/config';
import { REST, Routes } from 'discord.js';
import { commands } from '../src/commands.js';
const { DISCORD_TOKEN, CLIENT_ID, GUILD_ID } = process.env;
if(!DISCORD_TOKEN || !CLIENT_ID || !GUILD_ID) throw new Error('Cần DISCORD_TOKEN, CLIENT_ID, GUILD_ID trong .env');
await new REST({version:'10'}).setToken(DISCORD_TOKEN).put(Routes.applicationGuildCommands(CLIENT_ID,GUILD_ID),{body:commands});
console.log(`Đã đăng ký ${commands.length} lệnh cho guild ${GUILD_ID}.`);
