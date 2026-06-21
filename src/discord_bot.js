const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const db = require('./database');
const { calcTravelSeconds, formatTime } = require('./utils/travel-calc');

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
    ]
});

client.on('clientReady', () => {
    console.log(`[Discord] Tactical Bot active and logged in as ${client.user.tag}`);
});

function parseTimerInput(input) {
    const cleanInput = input.trim().toLowerCase();
    let durationMs = 0;

    // Grab hours and minutes using flexible regex (handles space or no space)
    const hourMatch = cleanInput.match(/(\d+)\s*(h|hour|hours)/);
    const minMatch = cleanInput.match(/(\d+)\s*(m|min|mins|minute|minutes)/);

    // If it doesn't match either, it's garbage input
    if (!hourMatch && !minMatch) return null; 

    if (hourMatch) durationMs += parseInt(hourMatch[1], 10) * 60 * 60 * 1000;
    if (minMatch) durationMs += parseInt(minMatch[1], 10) * 60 * 1000;

    return durationMs;
}

client.on('messageCreate', async (message) => {
    if (message.author.bot) return;
    if (!message.content.startsWith('!')) return;

    const args = message.content.slice(1).trim().split(/ +/);
    const command = args.shift().toLowerCase();

    // ----------------------------------------------------
    // !help - DISPLAY ALL AVAILABLE COMMANDS
    // ----------------------------------------------------
    if (command === 'help') {
        const embed = new EmbedBuilder()
            .setTitle('🛠️ Command Center Help')
            .setDescription('Here is a list of all available commands and how to use them:')
            .setColor('#10b981') // Green color
            .addFields(
                { name: '`!intels`', value: 'Opens an interactive text menu to browse tracked intelligence profiles.' },
                { name: '`!sys <system_id>`', value: 'Displays intel for a specific solar system (Planets, Fleets, Plans).\n*Example: `!sys 123`*' },
                { name: '`!intel <player_name>`', value: 'Displays detailed intelligence and stats for a specific player.\n*Example: `!intel PlayerOne`*' },
                { name: '`!dist <sys1_id> <sys2_id>`', value: 'Calculates the distance and required biology level between two systems.\n*Example: `!dist 100 200`*' },
                { name: '`!plan <sys_id> <planet_num> <instructions...>`', value: 'Adds a tactical plan/note to a specific planet. (Requires your Discord ID to be linked in the Hub).\n*Example: `!plan 123 4 Send colony ship`*' },
                { name: '`!vision <system_id> [alliance_tag]`', value: 'Performs a radar scan to see which alliance members have vision over a target system.\n*Example: `!vision 123 RAID`*' },
                { name: '`!holes [alliance_tag]`', value: 'Scans your alliance\'s territory to find empty planets, hostile threats, and planned slots.\n*Example: `!holes RAID`*' },
                { name: '`!tt <sysA> <plnA> <sysB> <plnB> <speed> <nrg>`', value: 'Calculates fleet travel time between two coordinates.\n*Example: `!tt 100 1 200 4 10 5`*\n*(You can also swap speed/energy for a player name: `!tt 100 1 200 4 PlayerOne`)*' },
                { name: '`!ghosts <sys_id> <planet_num> <alliance_tag>`', value: 'Calculates the shortest/longest hidden fleet arrival window from hostile members with radar vision over a system.\n*Example: `!ghosts 1 10 AO`*' },
                { name: '`!bio`', value: 'Generates intelligence alerts highlighting players who possess a +6 biology or science advantage over your personal bio level.' }
            )
            .setFooter({ text: 'AWT Intelligence Hub' });

        return message.reply({ embeds: [embed] });
    }

    // ----------------------------------------------------
    // !getid - DISPLAY CHANNEL ID
    // ----------------------------------------------------
    if (command === 'getid') {
        return message.reply(`The ID of this channel is: **${message.channel.id}**`);
    }

    // ----------------------------------------------------
    // !timer - SET A CUSTOM TIMER TO PING YOU BACK
    // ----------------------------------------------------

    if (message.content.startsWith('!timer ')) {
        const args = message.content.slice(7).trim(); // Strip away "!timer "
        
        if (!args) {
            return message.reply("❌ Usage: `!timer 10mins` or `!timer 1 hour 8 mins`");
        }

        const delayMs = parseTimerInput(args);

        if (!delayMs) {
            return message.reply("❌ Invalid format. Use simple relative timings like `10mins`, `1h 8m`, or `1 hour 5 minutes`.");
        }

        // Acknowledge the timer
        const minutesTotal = Math.round(delayMs / 60000);
        await message.reply(`⏰ Timer set! I will ping you here in **${minutesTotal} minutes**.`);

        // Wait and execute the ping
        setTimeout(() => {
            message.reply(`🔔 <@${message.author.id}> **TIME IS UP!** Your timer for "${args}" has finished.`);
        }, delayMs);
    }

    // ----------------------------------------------------
    // !bio - BIOLOGY THREAT MATRIX
    // ----------------------------------------------------
    if (command === 'bio') {
        const discordName = message.author.username;
        
        // Find the linked user session mapping
        const user = db.prepare(`SELECT id, game_name FROM app_users WHERE LOWER(discord_name) = ? OR LOWER(discord_name) = ?`)
                       .get(discordName.toLowerCase(), `@${discordName.toLowerCase()}`);

        if (!user) {
            return message.reply(`❌ Your Discord username (\`${discordName}\`) is not linked to any Hub account. Add it in the Command Center first.`);
        }

        // Pull the author's own recorded profiles to extract baseline values
        const me = db.prepare(`SELECT id, biology FROM players WHERE LOWER(name) = ?`).get(user.game_name.toLowerCase());
        if (!me) {
            return message.reply(`❌ Could not locate your player profile data (\`${user.game_name}\`) in the synced database tracking array. Please scan your profile in-game first.`);
        }

        const myBio = me.biology || 0;
        const threatThreshold = myBio + 6;

        // 1. Confirmed High Biology (has_intel = 1) -> Match bio directly
        const confirmedThreats = db.prepare(`
            SELECT p.name, p.biology, a.tag as ally_tag
            FROM players p
            LEFT JOIN alliances a ON p.alliance_id = a.id
            WHERE p.has_intel = 1 AND p.biology >= ? AND p.id != ?
            ORDER BY p.biology DESC, p.name ASC
            LIMIT 25
        `).all(threatThreshold, me.id);

        // 2. Suspected High Biology (has_intel = 0) -> Match science level as proxy ceiling
        const suspectedThreats = db.prepare(`
            SELECT p.name, p.science_level, a.tag as ally_tag
            FROM players p
            LEFT JOIN alliances a ON p.alliance_id = a.id
            WHERE p.has_intel = 0 AND p.science_level >= ? AND p.id != ?
            ORDER BY p.science_level DESC, p.name ASC
            LIMIT 25
        `).all(threatThreshold, me.id);

        const embed = new EmbedBuilder()
            .setTitle(`🧬 Biology Threat Matrix (Your Bio: ${myBio})`)
            .setDescription(`Scanning for active entities displaying an advantage of **+6** levels or higher over your baseline radar coverage (Threshold: **${threatThreshold}+**):`)
            .setColor('#10b981'); // Emerald green theme for bio profile metrics

        let confirmedStr = "";
        if (confirmedThreats.length > 0) {
            confirmedThreats.forEach(p => {
                const tagStr = p.ally_tag ? `[${p.ally_tag}] ` : "";
                confirmedStr += `• ${tagStr}${p.name} — Bio: **${p.biology}**\n`;
            });
        } else {
            confirmedStr = "*No verified out-of-range biology logs stored above threshold.*";
        }

        let suspectedStr = "";
        if (suspectedThreats.length > 0) {
            suspectedThreats.forEach(p => {
                const tagStr = p.ally_tag ? `[${p.ally_tag}] ` : "";
                suspectedStr += `• ${tagStr}${p.name} — Sci Lvl: **${p.science_level}**\n`;
            });
        } else {
            suspectedStr = "*No obscured high science metrics discovered.*";
        }

        embed.addFields(
            { name: `✅ Confirmed Bio Advantages (has_intel = 1)`, value: confirmedStr },
            { name: `⚠️ Unscanned Profiles / Proxy Threat Level (has_intel = 0 via Science Level)`, value: suspectedStr }
        );

        return message.reply({ embeds: [embed] });
    }

    // ----------------------------------------------------
    // !tt - TRAVEL TIME CALCULATOR
    // ----------------------------------------------------
    if (command === 'tt') {
        if (args.length < 5) {
            return message.reply('❌ **Usage:**\nManual: `!tt <sys_id_A> <planet_A> <sys_id_B> <planet_B> <racespeed> <energy>`\nSemi-manual: `!tt <sys_id_A> <planet_A> <sys_id_B> <planet_B> <player_name>`');
        }

        const sysA = parseInt(args[0], 10);
        const plnA = parseInt(args[1], 10);
        const sysB = parseInt(args[2], 10);
        const plnB = parseInt(args[3], 10);

        if (isNaN(sysA) || isNaN(plnA) || isNaN(sysB) || isNaN(plnB)) {
            return message.reply('❌ Invalid system or planet numbers provided.');
        }

        let speed = 0;
        let energy = 0;
        let playerNameDisplay = 'Manual Entry';

        // Check if manual entry
        if (args.length >= 6 && !isNaN(args[4]) && !isNaN(args[5])) {
            speed = parseInt(args[4], 10);
            energy = parseInt(args[5], 10);
        } else {
            // Semi-manual: look up player stats from the database
            const playerName = args.slice(4).join(' ');
            const player = db.prepare(`SELECT name, race_speed, energy FROM players WHERE name LIKE ?`).get(playerName);
            
            if (!player) {
                return message.reply(`❌ Player **${playerName}** not found in the database. Please provide valid stats manually or check the spelling.`);
            }
            
            speed = player.race_speed || 0;
            energy = player.energy || 0;
            playerNameDisplay = player.name;
        }

        const sys1 = db.prepare(`SELECT name, x, y FROM systems WHERE id = ?`).get(sysA);
        const sys2 = db.prepare(`SELECT name, x, y FROM systems WHERE id = ?`).get(sysB);

        if (!sys1) return message.reply(`❌ Origin System #${sysA} not found in the database.`);
        if (!sys2) return message.reply(`❌ Destination System #${sysB} not found in the database.`);

        // Successfully running the updated 9-parameter version
        const fullTimeSecs = calcTravelSeconds(sys1.x, sys1.y, plnA, sys2.x, sys2.y, plnB, energy, speed, false);
        const halfTimeSecs = calcTravelSeconds(sys1.x, sys1.y, plnA, sys2.x, sys2.y, plnB, energy, speed, true);

        const embed = new EmbedBuilder()
            .setTitle('⏱️ Travel Time Calculator')
            .setColor('#f59e0b')
            .addFields(
                { name: 'Origin', value: `**${sys1.name || 'Unknown'} #${sysA}**\nPlanet: ${plnA}\nCoords: ${sys1.x} / ${sys1.y}`, inline: true },
                { name: 'Destination', value: `**${sys2.name || 'Unknown'} #${sysB}**\nPlanet: ${plnB}\nCoords: ${sys2.x} / ${sys2.y}`, inline: true },
                { name: 'Profile Engine', value: `**${playerNameDisplay}**\nSpeed: ${speed}\nEnergy: ${energy}`, inline: true },
                { name: 'Standard Travel', value: `**${formatTime(fullTimeSecs)}**`, inline: true },
                { name: 'Alliance Travel (50%)', value: `**${formatTime(halfTimeSecs)}**`, inline: true }
            );

        return message.reply({ embeds: [embed] });
    }

    // ----------------------------------------------------
    // !intels - TEXT-BASED INTERACTIVE DRILLDOWN
    // ----------------------------------------------------
    if (command === 'intels') {
        const alliancesWithIntel = db.prepare(`
            SELECT DISTINCT a.id, a.tag
            FROM alliances a
            JOIN players p ON p.alliance_id = a.id
            WHERE p.has_intel = 1
            ORDER BY a.tag ASC
        `).all();

        // FIXED: Added missing 'p' alias to prevent SQLITE_ERROR
        const solosCount = db.prepare(`
            SELECT COUNT(*) as count FROM players p
            WHERE p.alliance_id IS NULL
            AND p.has_intel = 1
        `).get().count;

        if (alliancesWithIntel.length === 0 && solosCount === 0) {
            return message.reply('📭 No intelligence records found with active intel in the database.');
        }

        const groups = alliancesWithIntel.map(a => ({ id: a.id, name: a.tag || `Alliance #${a.id}`, type: 'alliance' }));
        if (solosCount > 0) {
            groups.push({ id: 'solos', name: 'Solos (No Alliance)', type: 'solos' });
        }

        let directoryStr = "";
        groups.forEach((g, idx) => {
            directoryStr += `**[${idx + 1}]** ${g.name}\n`;
        });

        const embed = new EmbedBuilder()
            .setTitle('📂 Intelligence Directory')
            .setDescription(`Type the number of the alliance/group you want to inspect:\n\n${directoryStr}`)
            .setColor('#3b82f6')
            .setFooter({ text: 'Session expires in 30 seconds of inactivity.' });

        const menuMessage = await message.reply({ embeds: [embed] });

        let currentStep = 1; 
        let chosenGroup = null;
        let groupPlayers = [];

        const filter = m => m.author.id === message.author.id;
        const collector = message.channel.createMessageCollector({ filter, time: 30000 });

        collector.on('collect', async (m) => {
            const input = m.content.trim();
            await m.delete().catch(() => {});

            if (currentStep === 1) {
                const idx = parseInt(input, 10) - 1;
                if (isNaN(idx) || idx < 0 || idx >= groups.length) {
                    const warningEmbed = new EmbedBuilder()
                        .setTitle('📂 Intelligence Directory')
                        .setDescription(`⚠️ **Invalid selection.** Please type a number between 1 and ${groups.length}.\n\n${directoryStr}`)
                        .setColor('#ef4444')
                        .setFooter({ text: 'Session expires in 30 seconds of inactivity.' });
                    await menuMessage.edit({ embeds: [warningEmbed] });
                    return;
                }

                chosenGroup = groups[idx];
                
                if (chosenGroup.type === 'solos') {
                    groupPlayers = db.prepare(`
                        SELECT id, name FROM players
                        WHERE alliance_id IS NULL AND has_intel = 1
                        ORDER BY name ASC
                    `).all();
                } else {
                    groupPlayers = db.prepare(`
                        SELECT id, name FROM players
                        WHERE alliance_id = ? AND has_intel = 1
                        ORDER BY name ASC
                    `).all(chosenGroup.id);
                }

                if (groupPlayers.length === 0) {
                    await menuMessage.edit({ content: '❌ No profile records located for this segment inside index files.', embeds: [] });
                    return collector.stop();
                }

                let playerStr = "";
                groupPlayers.forEach((p, pIdx) => {
                    playerStr += `**[${pIdx + 1}]** ${p.name}\n`;
                });

                const playerEmbed = new EmbedBuilder()
                    .setTitle(`👥 Tracked Profiles: ${chosenGroup.name}`)
                    .setDescription(`Type the number of the player you want to inspect:\n\n${playerStr}`)
                    .setColor('#22c55e')
                    .setFooter({ text: 'Session expires in 30 seconds of inactivity.' });

                await menuMessage.edit({ embeds: [playerEmbed] });
                currentStep = 2;
                collector.resetTimer({ time: 30000 });
            } 
            else if (currentStep === 2) {
                const pIdx = parseInt(input, 10) - 1;
                if (isNaN(pIdx) || pIdx < 0 || pIdx >= groupPlayers.length) {
                    let playerStr = "";
                    groupPlayers.forEach((p, idx) => {
                        playerStr += `**[${idx + 1}]** ${p.name}\n`;
                    });
                    const warningEmbed = new EmbedBuilder()
                        .setTitle(`👥 Tracked Profiles: ${chosenGroup.name}`)
                        .setDescription(`⚠️ **Invalid selection.** Choose a number between 1 and ${groupPlayers.length}.\n\n${playerStr}`)
                        .setColor('#ef4444')
                        .setFooter({ text: 'Session expires in 30 seconds of inactivity.' });
                    await menuMessage.edit({ embeds: [warningEmbed] });
                    return;
                }

                const targetPlayer = groupPlayers[pIdx];
                
                const player = db.prepare(`
                    SELECT p.*, a.tag as ally_tag,
                           (SELECT COUNT(*) FROM planets WHERE owner_id = p.id) as actual_planets,
                           (SELECT SUM(population) FROM planets WHERE owner_id = p.id) as actual_pop
                    FROM players p 
                    LEFT JOIN alliances a ON p.alliance_id = a.id 
                    WHERE p.id = ?
                `).get(targetPlayer.id);

                if (!player) {
                    await menuMessage.edit({ content: '❌ Selected target file no longer matches raw database hashes.', embeds: [] });
                    return collector.stop();
                }

                let countryDisplay = '--';
                if (player.country) {
                    let cleanCountry = player.country.replace('Players from ', '').trim();
                    if (cleanCountry === 'Lithuania') countryDisplay = 'LT';
                    else if (cleanCountry === 'United States' || cleanCountry === 'USA') countryDisplay = 'US';
                    else if (cleanCountry === 'United Kingdom' || cleanCountry === 'UK') countryDisplay = 'UK';
                    else countryDisplay = cleanCountry.substring(0, 3).toUpperCase();
                }

                let raceStatsVal = '';
                if (!player.has_intel) {
                    raceStatsVal = '⚠️ **Intel Not Available**\n*Scan player profile in-game to sync stats.*';
                } else {
                    raceStatsVal = `Gro: **${player.race_growth}** | Sci: **${player.race_science}**\nCul: **${player.race_culture}** | Pro: **${player.race_production}**\nSpd: **${player.race_speed}** | Atk: **${player.race_attack}**\nDef: **${player.race_defense}**`;
                    let extraTraits = [];
                    if (player.race_trader) extraTraits.push(`Tra: **${player.race_trader > 0 ? '+' : ''}${player.race_trader}**`);
                    if (player.race_sul) extraTraits.push(`SUL: **${player.race_sul > 0 ? '+' : ''}${player.race_sul}**`);
                    if (extraTraits.length > 0) raceStatsVal += `\n${extraTraits.join(' | ')}`;
                    raceStatsVal += `\n\n**Sciences**\nBio: **${player.biology}** | Eco: **${player.economy}**\nEne: **${player.energy}** | Mat: **${player.mathematics}**\nPhy: **${player.physics}** | Soc: **${player.social}**`;
                }

                const finalEmbed = new EmbedBuilder()
                    .setTitle(`👤 Intel: ${player.name} ${player.ally_tag ? `[${player.ally_tag}]` : ''}`)
                    .setColor('#3b82f6')
                    .addFields(
                        { 
                            name: '📊 Core & Status', 
                            value: `PL: **${player.level}**\nPoints: **${player.points}**\nRank: **${player.ranking}**\nOrigin: **#${player.origin_system || '--'}**\nLocal Time: **${player.local_time || '--'}**\nIdle Time: **${player.idle_time || '--'}**\nCountry: **${countryDisplay}**`, 
                            inline: true 
                        },
                        { 
                            name: '🏗️ Infrastructure', 
                            value: `Planets: **${player.actual_planets || 0} / ${player.has_intel ? player.culture_level : '--'}**\nTotal Pop: **${player.actual_pop || 0}**\nTrade Rev: **${player.has_intel ? (player.trade_revenue || 0).toLocaleString() : '--'}**\nProd: **${player.has_intel ? player.production_rate + '/h' : '--'}**\nSci: **${player.has_intel ? player.science_rate + '/h' : '--'}**\nCult: **${player.has_intel ? player.culture_rate + '/h' : '--'}**\nArtefact: **${player.artefact && player.artefact !== 'N/A' ? player.artefact : '--'}**`,
                            inline: true
                        },
                        {
                            name: '**Race & Science Intel**',
                            value: raceStatsVal, 
                            inline: true 
                        }
                    );

                await menuMessage.edit({ embeds: [finalEmbed] });
                collector.stop('completed');
            }
        });

        collector.on('end', (collected, reason) => {
            if (reason === 'time') {
                menuMessage.edit({ content: '⏱️ Intel directory interactive session expired.', embeds: [] }).catch(() => {});
            }
        });
    }

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

        const plans = db.prepare(`
            SELECT pp.*, u.game_name as author_name 
            FROM planet_plans pp
            LEFT JOIN app_users u ON pp.author_id = u.id
            WHERE pp.system_id = ?
        `).all(sysId);

        const fleets = db.prepare(`
            SELECT f.*, u.name as owner_name, a.tag as ally_tag
            FROM fleets f
            LEFT JOIN players u ON f.owner_id = u.id
            LEFT JOIN alliances a ON u.alliance_id = a.id
            WHERE f.system_id = ?
        `).all(sysId);

        const embed = new EmbedBuilder()
            .setTitle(`📡 System Intel: ${sys.name || 'Unknown'} #${sysId} (${sys.x || '--'} / ${sys.y || '--'})`)
            .setColor('#22c55e');

        let planetList = '';
        planets.forEach(p => {
            const owner = p.owner_name ? `[${p.ally_tag || '?'}] ${p.owner_name}` : '*Empty*';
            const sbText = p.starbase > 0 ? ` | 🛰️ SB: ${p.starbase}` : '';
            
            const plan = plans.find(pl => pl.planet_index === p.planet_index);
            const planText = plan ? ` | 📝 **Plan:** ${plan.note} *(by ${plan.author_name || 'Unknown'})*` : '';
            
            planetList += `**${p.planet_index}.** ${owner} (Pop: ${p.population || 0})${sbText}${planText}\n`;
        });

        if (planetList) embed.addFields({ name: 'Planets', value: planetList });

        const embeds = [embed];

        if (fleets.length > 0) {
            let fleetList = '';
            fleets.forEach(f => {
                const cv = (f.destroyers * 3) + (f.cruisers * 24) + (f.battleships * 60);
                const owner = f.owner_name ? `[${f.ally_tag || '?'}] ${f.owner_name}` : '*Unknown*';
                
                fleetList += `Planet **${f.planet_index}**: ${owner} — CV **${cv.toLocaleString()}** (${f.arrival_time ? 'Moving: ' + f.arrival_time : 'Orbiting'})\n`;
            });

            if (fleetList) {
                const fleetEmbed = new EmbedBuilder()
                    .setTitle(`🚀 Fleets`)
                    .setColor('#3b82f6') 
                    .setDescription(fleetList);
                embeds.push(fleetEmbed);
            }
        }

        return message.reply({ embeds: embeds });
    }

    // ----------------------------------------------------
    // !intel <name> - DISPLAY PLAYER INTEL
    // ----------------------------------------------------
    if (command === 'intel') {
        const playerName = args.join(' ');
        if (!playerName) return message.reply('❌ Usage: `!intel <player_name>`');

        const player = db.prepare(`
            SELECT p.*, a.tag as ally_tag,
                   (SELECT COUNT(*) FROM planets WHERE owner_id = p.id) as actual_planets,
                   (SELECT SUM(population) FROM planets WHERE owner_id = p.id) as actual_pop
            FROM players p 
            LEFT JOIN alliances a ON p.alliance_id = a.id 
            WHERE p.name LIKE ?
        `).get(playerName);

        if (!player) return message.reply(`❌ Player **${playerName}** not found in the database.`);

        let countryDisplay = '--';
        if (player.country) {
            let cleanCountry = player.country.replace('Players from ', '').trim();
            if (cleanCountry === 'Lithuania') countryDisplay = 'LT';
            else if (cleanCountry === 'United States' || cleanCountry === 'USA') countryDisplay = 'US';
            else if (cleanCountry === 'United Kingdom' || cleanCountry === 'UK') countryDisplay = 'UK';
            else countryDisplay = cleanCountry.substring(0, 3).toUpperCase();
        }

        let raceStatsVal = '';
        if (!player.has_intel) {
            raceStatsVal = '⚠️ **Intel Not Available**\n*Scan player profile in-game to sync stats.*';
        } else {
            raceStatsVal = `Gro: **${player.race_growth}** | Sci: **${player.race_science}**\nCul: **${player.race_culture}** | Pro: **${player.race_production}**\nSpd: **${player.race_speed}** | Atk: **${player.race_attack}**\nDef: **${player.race_defense}**`;
            let extraTraits = [];
            if (player.race_trader) extraTraits.push(`Tra: **${player.race_trader > 0 ? '+' : ''}${player.race_trader}**`);
            if (player.race_sul) extraTraits.push(`SUL: **${player.race_sul > 0 ? '+' : ''}${player.race_sul}**`);
            if (extraTraits.length > 0) raceStatsVal += `\n${extraTraits.join(' | ')}`;
            raceStatsVal += `\n\n**Sciences**\nBio: **${player.biology}** | Eco: **${player.economy}**\nEne: **${player.energy}** | Mat: **${player.mathematics}**\nPhy: **${player.physics}** | Soc: **${player.social}**`;
        }

        const embed = new EmbedBuilder()
            .setTitle(`👤 Intel: ${player.name} ${player.ally_tag ? `[${player.ally_tag}]` : ''}`)
            .setColor('#3b82f6')
            .addFields(
                { 
                    name: '📊 Core & Status', 
                    value: `PL: **${player.level}**\nPoints: **${player.points}**\nRank: **${player.ranking}**\nOrigin: **#${player.origin_system || '--'}**\nLocal Time: **${player.local_time || '--'}**\nIdle Time: **${player.idle_time || '--'}**\nCountry: **${countryDisplay}**`, 
                    inline: true 
                },
                { 
                    name: '🏗️ Infrastructure', 
                    value: `Planets: **${player.actual_planets || 0} / ${player.has_intel ? player.culture_level : '--'}**\nTotal Pop: **${player.actual_pop || 0}**\nTrade Rev: **${player.has_intel ? (player.trade_revenue || 0).toLocaleString() : '--'}**\nProd: **${player.has_intel ? player.production_rate + '/h' : '--'}**\nSci: **${player.has_intel ? player.science_rate + '/h' : '--'}**\nCult: **${player.has_intel ? player.culture_rate + '/h' : '--'}**\nArtefact: **${player.artefact && player.artefact !== 'N/A' ? player.artefact : '--'}**`,
                    inline: true
                },
                { 
                    name: '**Race & Science Intel**', 
                    value: raceStatsVal, 
                    inline: true 
                }
            );

        return message.reply({ embeds: [embed] });
    }

    // ----------------------------------------------------
    // !dist <sys_id> <sys_id> - DISTANCE CALC
    // ----------------------------------------------------
    if (command === 'dist') {
        const id1 = args[0];
        const id2 = args[1];

        if (!id1 || !id2 || isNaN(id1) || isNaN(id2)) {
            return message.reply('❌ Usage: `!dist <sys1_id> <sys2_id>`');
        }

        const sys1 = db.prepare(`SELECT name, x, y FROM systems WHERE id = ?`).get(id1);
        const sys2 = db.prepare(`SELECT name, x, y FROM systems WHERE id = ?`).get(id2);

        if (!sys1) return message.reply(`❌ System #${id1} not found.`);
        if (!sys2) return message.reply(`❌ System #${id2} not found.`);

        const dx = sys2.x - sys1.x;
        const dy = sys2.y - sys1.y;
        const distance = Math.sqrt((dx * dx) + (dy * dy));
        const bioNeeded = Math.ceil(distance);

        const embed = new EmbedBuilder()
            .setTitle('🗺️ Distance Calculator')
            .setColor('#a855f7')
            .addFields(
                { name: `Origin`, value: `**${sys1.name || 'Unknown'} #${id1}**\nCoords: ${sys1.x} / ${sys1.y}`, inline: true },
                { name: `Destination`, value: `**${sys2.name || 'Unknown'} #${id2}**\nCoords: ${sys2.x} / ${sys2.y}`, inline: true },
                { name: `Result`, value: `Vector Dist: **${distance.toFixed(2)}**\nBio Needed: **${bioNeeded}**`, inline: true }
            );

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
            `).run(sysId, pIdx, user.id, note);
            
            message.react('✅');
            message.reply(`✅ Plan saved for System **#${sysId}** Planet **${pIdx}** by ${user.game_name}.`);
        } catch (err) {
            console.error(err);
            message.reply('❌ Database error while saving plan.');
        }
    }

    // ----------------------------------------------------
    // !vision <system_id> [tag] - RADAR SCAN
    // ----------------------------------------------------
    if (command === 'vision') {
        const sysId = args[0];
        if (!sysId || isNaN(sysId)) return message.reply("❌ Usage: `!vision <system_id> [alliance_tag]`");

        const targetSysId = parseInt(sysId, 10);
        const tag = args[1] ? args[1].toUpperCase() : 'RAID';

        const targetSys = db.prepare("SELECT name, x, y FROM systems WHERE id = ?").get(targetSysId);
        if (!targetSys) return message.reply(`❌ System **[${targetSysId}]** not found in the database. Scan or fly near it first.`);

        const players = db.prepare(`
            SELECT p.name, p.biology, p.science_level, s.x, s.y
            FROM players p
            JOIN alliances a ON p.alliance_id = a.id
            JOIN systems s ON p.origin_system = s.id
            WHERE a.tag = ?
            AND p.origin_system IS NOT NULL 
            AND p.origin_system > 0
        `).all(tag);

        if (!players || players.length === 0) {
            return message.reply(`❌ No players found for alliance [${tag}] with a recorded Origin System.`);
        }

        const inVision = [];
        const outOfVision = [];
        const tx = targetSys.x;
        const ty = targetSys.y;

        players.forEach(p => {
            const distance = Math.sqrt(Math.pow(p.x - tx, 2) + Math.pow(p.y - ty, 2));
            const requiredBio = Math.ceil(distance);
            const visionRadius = (p.biology && p.biology > 0) ? p.biology : (p.science_level || 1);

            if (visionRadius >= requiredBio) {
                // Displays their current vision ceiling alongside what was actually required
                inVision.push(`${p.name} (Has: **${visionRadius}** / Needs: **${requiredBio}**)`);
            } else {
                // Displays exactly how short they are of getting vision
                outOfVision.push(`${p.name} (Has: **${visionRadius}** / Needs: **${requiredBio}**)`);
            }
        });

        let inVisionStr = inVision.length > 0 ? inVision.join('\n') : "None";
        let outOfVisionStr = outOfVision.length > 0 ? outOfVision.join('\n') : "None";

        if (inVisionStr.length > 1024) inVisionStr = inVisionStr.substring(0, 1020) + "...";
        if (outOfVisionStr.length > 1024) outOfVisionStr = outOfVisionStr.substring(0, 1020) + "...";

        const embed = new EmbedBuilder()
            .setTitle(`📡 Bio-Scan Radar: ${targetSys.name || 'Unknown'} [${targetSysId}]`)
            .setColor('#00ffff')
            .addFields(
                { name: '✅ In Vision', value: inVisionStr },
                { name: '❌ Out of Range', value: outOfVisionStr }
            );

        return message.reply({ embeds: [embed] });
    }

    // ----------------------------------------------------
    // !holes [tag] - FIND EMPTY ALLIANCE SLOTS
    // ----------------------------------------------------
    if (command === 'holes') {
        let tag = args[0] ? args[0].toUpperCase() : null;

        if (!tag) {
            const discordName = message.author.username;
            const userAlliance = db.prepare(`
                SELECT a.tag 
                FROM app_users u
                JOIN players p ON u.game_name = p.name
                JOIN alliances a ON p.alliance_id = a.id
                WHERE LOWER(u.discord_name) = ? OR LOWER(u.discord_name) = ?
            `).get(discordName.toLowerCase(), `@${discordName.toLowerCase()}`);

            if (!userAlliance || !userAlliance.tag) {
                return message.reply(`❌ Could not automatically detect your alliance. Provide it explicitly: \`!holes <tag>\``);
            }
            tag = userAlliance.tag.toUpperCase();
        }

        // FETCHES BOTH OWNER NAME AND OWNER ALLIANCE TAG FOR COMPREHENSIVE SECTOR SCANNING
        const rows = db.prepare(`
            SELECT p.system_id, s.name as sys_name, p.planet_index, u.name as owner_name, a.tag as owner_alliance_tag
            FROM planets p
            JOIN systems s ON p.system_id = s.id
            LEFT JOIN players u ON p.owner_id = u.id
            LEFT JOIN alliances a ON u.alliance_id = a.id
            WHERE p.system_id IN (
                SELECT DISTINCT p2.system_id
                FROM planets p2
                JOIN players u2 ON p2.owner_id = u2.id
                JOIN alliances a2 ON u2.alliance_id = a2.id
                WHERE a2.tag = ?
            )
        `).all(tag);

        const planRows = db.prepare(`SELECT system_id, planet_index FROM planet_plans`).all();

        if (!rows || rows.length === 0) {
            return message.reply(`❌ No scanned systems found with an active presence for alliance [${tag}].`);
        }

        const sysData = {};
        rows.forEach(r => {
            if (!sysData[r.system_id]) {
                sysData[r.system_id] = { name: r.sys_name, planets: {} };
            }
            if (r.planet_index) {
                sysData[r.system_id].planets[r.planet_index] = {
                    owner_name: r.owner_name,
                    owner_alliance_tag: r.owner_alliance_tag
                };
            }
        });

        const planMap = {};
        planRows.forEach(p => {
            if (!planMap[p.system_id]) planMap[p.system_id] = [];
            planMap[p.system_id].push(p.planet_index);
        });

        let report = "";
        let systemsWithHoles = 0;

        const sortedSysIds = Object.keys(sysData).map(Number).sort((a, b) => a - b);

        for (const sysId of sortedSysIds) {
            const data = sysData[sysId];
            const freeSlots = [];
            const plannedSlots = [];
            const enemySlots = [];
            const plannedForSys = planMap[sysId] || [];

            for (let i = 1; i <= 12; i++) {
                const planetData = data.planets[i];
                const owner = planetData ? planetData.owner_name : null;
                const ownerTag = planetData ? planetData.owner_alliance_tag : null;
                
                const isPlanned = plannedForSys.includes(i);
                const isFree = !owner || owner === "Free Planet" || owner === "Empty" || owner === "Unknown";

                if (isPlanned) {
                    plannedSlots.push(`P${i.toString().padStart(2, '0')}`);
                } else if (isFree) {
                    freeSlots.push(`P${i.toString().padStart(2, '0')}`);
                } else {
                    const isFriendly = ownerTag && ownerTag.toUpperCase() === tag;
                    if (!isFriendly) {
                        enemySlots.push(`P${i.toString().padStart(2, '0')}`);
                    }
                }
            }

            // Only appends the system line if there are open holes, targets planned, or enemy threats inside it
            if (freeSlots.length > 0 || plannedSlots.length > 0 || enemySlots.length > 0) {
                systemsWithHoles++;
                
                let segments = [];
                if (freeSlots.length > 0) segments.push(`Free - ${freeSlots.join(', ')}`);
                if (plannedSlots.length > 0) segments.push(`Planned - *${plannedSlots.join(', ')}*`);
                if (enemySlots.length > 0) segments.push(`Enemy - **${enemySlots.join(', ')}**`);
                
                report += `**[${sysId}]** ${data.name || "Unknown System"}: ${segments.join(' | ')}\n`;
            }
        }

        if (systemsWithHoles === 0) {
            return message.reply(`🟢 No vulnerabilities located. All slots in [${tag}] territory are securely held by your alliance.`);
        }

        if (report.length > 4000) {
            report = report.substring(0, 4000) + "\n\n... *(list truncated due to Discord length limits)*";
        }

        const embed = new EmbedBuilder()
            .setTitle(`🕳️ Sector Vulnerability Matrix: [${tag}]`)
            .setDescription(report)
            .setColor('#f97316')
            .setFooter({ text: `Monitored systems: ${systemsWithHoles} | *Italics* = Spoken for (!plan) | **Bold** = Hostile Presence` });

        return message.reply({ embeds: [embed] });
    }

    // ----------------------------------------------------
    // !ghosts <sys_id> <planet> <alliance_tag> - GHOST FORECAST
    // ----------------------------------------------------
    if (command === 'ghosts') {
        const sysId = parseInt(args[0], 10);
        const planetNum = parseInt(args[1], 10);
        const tag = args[2] ? args[2].toUpperCase() : null;

        if (isNaN(sysId) || isNaN(planetNum) || !tag) {
            return message.reply('❌ **Usage:** `!ghosts <system_id> <planet_num> <alliance_tag>`\n*Example: `!ghosts 1 10 AO`*');
        }

        const targetSys = db.prepare("SELECT name, x, y FROM systems WHERE id = ?").get(sysId);
        if (!targetSys) return message.reply(`❌ System **[${sysId}]** not found in the database.`);

        // Find all players in that alliance with an origin system recorded
        const alliancePlayers = db.prepare(`
            SELECT p.id, p.name, p.biology, p.science_level, p.energy, p.race_speed, s.id as orig_sys_id, s.x as orig_x, s.y as orig_y
            FROM players p
            JOIN alliances a ON p.alliance_id = a.id
            JOIN systems s ON p.origin_system = s.id
            WHERE a.tag = ?
        `).all(tag);

        if (!alliancePlayers || alliancePlayers.length === 0) {
            return message.reply(`❌ No tracked players found for alliance [${tag}] with known origin systems.`);
        }

        const tx = targetSys.x;
        const ty = targetSys.y;
        const ghostLines = [];

        alliancePlayers.forEach(p => {
            // 1. Radar Vision Check (using their origin system as radar baseline)
            const distanceToTarget = Math.sqrt(Math.pow(p.orig_x - tx, 2) + Math.pow(p.orig_y - ty, 2));
            const requiredBio = Math.ceil(distanceToTarget);
            const visionRadius = (p.biology && p.biology > 0) ? p.biology : (p.science_level || 1);

            // If they didn't have vision over the system, they couldn't see to react/launch
            if (visionRadius < requiredBio) return;

            // 2. Gather all possible launch points (Scraped planets + Origin system baseline)
            const launchPoints = [];
            launchPoints.push({ x: p.orig_x, y: p.orig_y, planet_index: 1 }); // Default fallback slot

            const scrapedPlanets = db.prepare(`
                SELECT p.planet_index, s.x, s.y
                FROM planets p
                JOIN systems s ON p.system_id = s.id
                WHERE p.owner_id = ?
            `).all(p.id);

            scrapedPlanets.forEach(sp => {
                if (!launchPoints.some(lp => lp.x === sp.x && lp.y === sp.y && lp.planet_index === sp.planet_index)) {
                    launchPoints.push({ x: sp.x, y: sp.y, planet_index: sp.planet_index });
                }
            });

            // 3. Compute travel window extrema across their entire empire cluster
            let minTime = Infinity;
            let maxTime = -Infinity;

            launchPoints.forEach(lp => {
                const secs = calcTravelSeconds(lp.x, lp.y, lp.planet_index, tx, ty, planetNum, p.energy, p.race_speed, false);
                if (secs < minTime) minTime = secs;
                if (secs > maxTime) maxTime = secs;
            });

            if (minTime !== Infinity) {
                ghostLines.push({
                    name: p.name,
                    minStr: formatTime(minTime),
                    maxStr: formatTime(maxTime),
                    minVal: minTime
                });
            }
        });

        if (ghostLines.length === 0) {
            return message.reply(`🟢 Safe sector check: No members of [${tag}] hold active radar vision over system #${sysId}. No ghosts possible.`);
        }

        // Sort dynamically by closest potential threat arrivals first
        ghostLines.sort((a, b) => a.minVal - b.minVal);

        let reportStr = "";
        ghostLines.forEach((g, idx) => {
            reportStr += `**${idx + 1}. ${g.name}**: shortest \`${g.minStr}\`, longest \`${g.maxStr}\`\n`;
        });

        const embed = new EmbedBuilder()
            .setTitle(`👻 Stealth Ghost Trajectory Matrix: [${tag}]`)
            .setDescription(`Possible pre-capture incoming tracking windows for **Planet #${planetNum}** in system **${targetSys.name || 'Unknown'} [${sysId}]**:\n\n${reportStr}`)
            .setColor('#4b5563') // Tactical slate-gray
            .setFooter({ text: 'Calculated using server vector configurations.' });

        return message.reply({ embeds: [embed] });
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

// ----------------------------------------------------
// SYSTEM CHANGE ANNOUNCER (used by the galaxy scanner)
// ----------------------------------------------------
function getSettingValue(key) {
    try {
        const row = db.prepare(`SELECT value FROM app_settings WHERE key = ?`).get(key);
        const v = row && row.value ? row.value.trim() : '';
        return v || null;
    } catch (err) {
        return null;
    }
}

function getAnnounceChannelId() {
    return getSettingValue('discord_announce_channel');
}

/**
 * Announce planet events detected for a single system to the configured channel.
 * `events` is an array of { planet_index, type, old_owner, new_owner, old_pop, new_pop }.
 * Safe no-op if the bot isn't ready, no channel is configured, or there are no events.
 */
async function announceSystemChanges(system, events) {
    if (!Array.isArray(events) || events.length === 0) return;
    if (!client.isReady()) return;

    const channelId = getAnnounceChannelId();
    if (!channelId) return;

    let channel;
    try {
        channel = await client.channels.fetch(channelId);
    } catch (err) {
        console.error('[Discord] Could not fetch announce channel:', err.message);
        return;
    }
    if (!channel || typeof channel.send !== 'function') return;

    const sysLabel = `${system.name ? system.name + ' ' : ''}#${system.id}${(system.x != null && system.y != null) ? ` (${system.x}/${system.y})` : ''}`;

    const lines = events.map(e => {
        if (e.type === 'OWNER_CHANGE') {
            return `🪐 **Planet ${e.planet_index}**: ${e.old_owner || 'Empty'} → **${e.new_owner || 'Empty'}**`;
        }
        if (e.type === 'POP_DROP') {
            return `📉 **Planet ${e.planet_index}**: population ${e.old_pop} → ${e.new_pop}`;
        }
        return null;
    }).filter(Boolean);

    if (lines.length === 0) return;

    const embed = new EmbedBuilder()
        .setTitle(`🛰️ System Change: ${sysLabel}`)
        .setDescription(lines.join('\n'))
        .setColor('#f59e0b');

    try {
        await channel.send({ embeds: [embed] });
    } catch (err) {
        console.error('[Discord] Failed to send system change announcement:', err.message);
    }
}

/**
 * Send a pre-built incoming-attack alert to the configured incoming channel.
 * The webhook route assembles the message (it has DB + travel-calc access);
 * the bot just delivers it. Safe no-op if not ready or no channel configured.
 */
async function sendIncomingAlert(content) {
    if (!client.isReady()) return false;
    const channelId = getSettingValue('discord_incoming_channel');
    if (!channelId) return false;

    let channel;
    try {
        channel = await client.channels.fetch(channelId);
    } catch (err) {
        console.error('[Discord] Could not fetch incoming channel:', err.message);
        return false;
    }
    if (!channel || typeof channel.send !== 'function') return false;

    // Discord hard-caps message content at 2000 chars.
    const text = content.length > 1990 ? content.slice(0, 1987) + '...' : content;
    try {
        await channel.send({ content: text });
        return true;
    } catch (err) {
        console.error('[Discord] Failed to send incoming alert:', err.message);
        return false;
    }
}

module.exports = { initDiscordBot, announceSystemChanges, sendIncomingAlert };