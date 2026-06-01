const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const db = require('./database'); 

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

client.on('messageCreate', async (message) => {
    if (message.author.bot) return;
    if (!message.content.startsWith('!')) return;

    const args = message.content.slice(1).trim().split(/ +/);
    const command = args.shift().toLowerCase();

    // ----------------------------------------------------
    // !getid - DISPLAY CHANNEL ID
    // ----------------------------------------------------
    if (command === 'getid') {
        return message.reply(`The ID of this channel is: **${message.channel.id}**`);
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
                            value: `Planets: **${player.actual_planets || 0} / ${player.has_intel ? player.culture_level : '--'}**\nTotal Pop: **${player.actual_pop || 0}**\nTrade Rev: **${player.has_intel ? player.trade_revenue.toLocaleString() : '--'}**\nProd: **${player.has_intel ? player.production_rate + '/h' : '--'}**\nSci: **${player.has_intel ? player.science_rate + '/h' : '--'}**\nCult: **${player.has_intel ? player.culture_rate + '/h' : '--'}**\nArtefact: **${player.artefact && player.artefact !== 'N/A' ? player.artefact : '--'}**`, 
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
                    value: `Planets: **${player.actual_planets || 0} / ${player.has_intel ? player.culture_level : '--'}**\nTotal Pop: **${player.actual_pop || 0}**\nTrade Rev: **${player.has_intel ? player.trade_revenue.toLocaleString() : '--'}**\nProd: **${player.has_intel ? player.production_rate + '/h' : '--'}**\nSci: **${player.has_intel ? player.science_rate + '/h' : '--'}**\nCult: **${player.has_intel ? player.culture_rate + '/h' : '--'}**\nArtefact: **${player.artefact && player.artefact !== 'N/A' ? player.artefact : '--'}**`, 
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
                inVision.push(p.name);
            } else {
                outOfVision.push(p.name);
            }
        });

        let inVisionStr = inVision.length > 0 ? inVision.join(', ') : "None";
        let outOfVisionStr = outOfVision.length > 0 ? outOfVision.join(', ') : "None";

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

        const rows = db.prepare(`
            SELECT p.system_id, s.name as sys_name, p.planet_index, u.name as owner_name
            FROM planets p
            JOIN systems s ON p.system_id = s.id
            LEFT JOIN players u ON p.owner_id = u.id
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
                sysData[r.system_id].planets[r.planet_index] = r.owner_name;
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
            const holes = [];
            let closedCount = 0;
            const plannedForSys = planMap[sysId] || [];

            for (let i = 1; i <= 12; i++) {
                const owner = data.planets[i];
                const isPlanned = plannedForSys.includes(i);
                const isUnknown = !owner || owner === "Unknown";
                const isFree = owner === "Free Planet" || owner === "Empty";

                if (!isUnknown && !isFree) {
                    closedCount++; 
                } else if (!isPlanned) {
                    holes.push(`P${i.toString().padStart(2, '0')}`); 
                }
            }

            if (holes.length > 0) {
                systemsWithHoles++;
                report += `**[${sysId}]** ${data.name || "Unknown System"}: ${holes.join(', ')} | Planned - ${plannedForSys.length} | Closed - ${closedCount}\n`;
            }
        }

        if (systemsWithHoles === 0) {
            return message.reply(`🟢 No holes found! All slots in [${tag}] systems are filled or planned.`);
        }

        if (report.length > 4000) {
            report = report.substring(0, 4000) + "\n\n... *(list truncated due to Discord length limits)*";
        }

        const embed = new EmbedBuilder()
            .setTitle(`🕳️ System Holes for [${tag}]`)
            .setDescription(report)
            .setColor('#00ff00')
            .setFooter({ text: `Found holes in ${systemsWithHoles} systems | Ignoring planets with active !plans` });

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

module.exports = { initDiscordBot };