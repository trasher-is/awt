const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const db = require('./database'); 

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
    ]
});

client.on('ready', () => {
    console.log(`[Discord] Tactical Bot active and logged in as ${client.user.tag}`);
});

client.on('messageCreate', async (message) => {
    if (message.author.bot) return;
    if (!message.content.startsWith('!')) return;

    const args = message.content.slice(1).trim().split(/ +/);
    const command = args.shift().toLowerCase();

    // ----------------------------------------------------
    // !sys <id> - DISPLAY SYSTEM INTEL
    // ----------------------------------------------------
    if (command === 'sys') {
        const sysId = args[0];
        if (!sysId || isNaN(sysId)) return message.reply('❌ Usage: `!sys <system_id>`');

        const sys = db.prepare(`SELECT * FROM systems WHERE id = ?`).get(sysId);
        if (!sys) return message.reply(`❌ System #${sysId} is not in the Hub database. Scan it in-game first.`);

        const planets = db.prepare(`
            SELECT p.*, u.name as owner_name, a.tag as ally_tag
            FROM planets p
            LEFT JOIN players u ON p.owner_id = u.id
            LEFT JOIN alliances a ON u.alliance_id = a.id
            WHERE p.system_id = ? ORDER BY p.planet_index ASC
        `).all(sysId);

        const fleets = db.prepare(`SELECT * FROM fleets WHERE system_id = ?`).all(sysId);
        const plans = db.prepare(`SELECT * FROM planet_plans WHERE system_id = ?`).all(sysId);

        const embed = new EmbedBuilder()
            .setTitle(`📡 System Intel: ${sys.name || 'Unknown'} #${sysId}`)
            .setDescription(`Coordinates: **${sys.x || '--'} / ${sys.y || '--'}**`)
            .setColor('#22c55e');

        let planetList = '';
        planets.forEach(p => {
            const owner = p.owner_name ? `[${p.ally_tag || '?'}] ${p.owner_name}` : '*Empty*';
            const plan = plans.find(pl => pl.planet_index === p.planet_index);
            const planText = plan ? `\n   ↳ 📝 **Plan:** ${plan.note}` : '';
            planetList += `**${p.planet_index}.** ${owner} (Pop: ${p.population || 0})${planText}\n`;
        });

        if (planetList) embed.addFields({ name: 'Planets', value: planetList });

        let fleetList = '';
        fleets.forEach(f => {
            const cv = (f.destroyers * 3) + (f.cruisers * 24) + (f.battleships * 60);
            fleetList += `Planet **${f.planet_index}**: CV **${cv.toLocaleString()}** (${f.arrival_time ? 'Moving: ' + f.arrival_time : 'Orbiting'})\n`;
        });

        if (fleetList) embed.addFields({ name: 'Enemy Fleets', value: fleetList });

        return message.reply({ embeds: [embed] });
    }

    // ----------------------------------------------------
    // !plan <sys_id> <planet_index> <note> - ADD A PLAN
    // ----------------------------------------------------
    if (command === 'plan') {
        const sysId = args[0];
        const pIdx = args[1];
        const note = args.slice(2).join(' ');

        if (!sysId || !pIdx || !note) {
            return message.reply('❌ Usage: `!plan <system_id> <planet_num> <instructions...>`');
        }

        // Cross-reference the Discord user with the Hub database
        const discordName = message.author.username;
        const user = db.prepare(`SELECT id, game_name FROM app_users WHERE LOWER(discord_name) = ? OR LOWER(discord_name) = ?`)
                       .get(discordName.toLowerCase(), `@${discordName.toLowerCase()}`);

        if (!user) {
            return message.reply(`❌ Your Discord username (\`${discordName}\`) is not linked to any Hub account. Add it in the Command Center first.`);
        }

        try {
            db.prepare(`
                INSERT INTO planet_plans (system_id, planet_index, author_id, note) 
                VALUES (?, ?, ?, ?)
                ON CONFLICT(system_id, planet_index) DO UPDATE SET 
                    note=excluded.note, 
                    author_id=excluded.author_id, 
                    updated_at=CURRENT_TIMESTAMP
            `).run(sysId, pIdx, user.id, note);
            
            message.react('✅');
            message.reply(`✅ Plan saved for System **#${sysId}** Planet **${pIdx}** by ${user.game_name}.`);
        } catch (err) {
            console.error(err);
            message.reply('❌ Database error while saving plan.');
        }
    }
});

function initDiscordBot(token) {
    if (!token) {
        console.log('[Discord] No DISCORD_TOKEN found in environment. Bot disabled.');
        return;
    }
    client.login(token).catch(err => {
        console.error('[Discord] Failed to connect:', err.message);
    });
}

module.exports = { initDiscordBot };