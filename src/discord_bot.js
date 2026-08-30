const { Client, GatewayIntentBits, EmbedBuilder, ButtonBuilder, ActionRowBuilder, ButtonStyle, MessageFlags } = require('discord.js');
const db = require('./database');
const systemsRepo = require('./repositories/systems');
const fleetsRepo = require('./repositories/fleets');
const plansRepo = require('./repositories/plans');
const playersRepo = require('./repositories/players');
const alliancesRepo = require('./repositories/alliances');
const usersRepo = require('./repositories/users');
const discordTimersRepo = require('./repositories/discordTimers');
const incomingRepo = require('./repositories/incoming');
const notesRepo = require('./repositories/notes');
const settingsRepo = require('./repositories/settings');
const battlePointsRepo = require('./repositories/battlePoints');
const battleReportsRepo = require('./repositories/battleReports');
const { calcTravelSeconds, formatTime } = require('./utils/travel-calc');
const { toggleCovering, getCovering, renderCoverLine, applyCoverLine } = require('./utils/covering');
// The battle model — the same physical file the dashboard calculator imports, so
// !battle and the web calculator cannot drift apart again. See docs/battle-model.md.
const battleModel = require('../public/js/utils/battle-model.js');
const { buildCommands, suggestPlayers, suggestSystems, isEphemeral } = require('./discord-commands');

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
    ]
});

client.on('clientReady', () => {
    console.log(`[Discord] Tactical Bot active and logged in as ${client.user.tag}`);
    // Run both checks immediately on connect: anything that came due while the process
    // was down fires now rather than waiting for the first tick.
    const tick = () => {
        checkNoteReminders().catch(err => console.error('[Discord] Reminder check failed:', err.message));
        checkDueTimers().catch(err => console.error('[Discord] Timer check failed:', err.message));
    };
    tick();
    setInterval(tick, 60 * 1000);
    registerSlashCommands().catch(err => console.error('[Discord] Slash command registration failed:', err.message));
});

// The "🛡️ I cover this" button attached to every incoming alert. customId carries the
// attack identity so a click can be routed back to the right incoming (well under the
// 100-char customId cap — alertKey is "system:planet:attacker").
function coverButtonRow(alertKey) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`cover:${alertKey}`)
            .setLabel('I cover this')
            .setEmoji('🛡️')
            .setStyle(ButtonStyle.Success)
    );
}

// Handle "I cover this" button clicks: toggle the clicker into/out of the covering roster
// and edit the alert in place so everyone sees who has defence on the way. Uses the
// clicker's linked Hub name when available, else their Discord username.
client.on('interactionCreate', async (interaction) => {
    try {
        if (!interaction.isButton() || !interaction.customId.startsWith('cover:')) return;
        const alertKey = interaction.customId.slice('cover:'.length);

        let name = interaction.user.username;
        try {
            const row = usersRepo.getUserByDiscordId(interaction.user.id);
            if (row && row.game_name) name = row.game_name;
        } catch (e) { /* fall back to Discord username */ }

        toggleCovering(alertKey, name);
        const content = applyCoverLine(interaction.message.content, renderCoverLine(getCovering(alertKey)));
        // interaction.update edits the message the button lives on AND acknowledges the
        // click, so the whole channel sees the updated roster with no extra ping.
        await interaction.update({ content, components: [coverButtonRow(alertKey)] });
    } catch (e) {
        console.error('[Discord] cover button failed:', e.message);
        try { await interaction.reply({ content: '⚠️ Could not register your cover — try again.', flags: MessageFlags.Ephemeral }); } catch (_) {}
    }
});

// ─── ACCOUNT LINKING ──────────────────────────────────────────────────────────
// !link used to take a Hub account NAME and bind the caller's Discord id to it. That
// proved nothing: anyone could claim any unlinked account by typing someone else's name.
// It mattered because the linked id decides who gets @mentioned on incoming alerts and
// who !plan records notes as.
//
// It is now a challenge/response. The code is minted in the Hub panel, where the person
// is already authenticated, and spent here — so completing a link requires holding both
// sides. Codes are single-use and expire in ten minutes.
//
// Existing links keep working untouched: this only governs how NEW ones are made.
async function handleLink({ code, userId, username, tag, reply }) {
    const already = usersRepo.getUserByDiscordId(userId);

    if (!code) {
        if (already) {
            return reply(`ℹ️ You are already linked to **${already.game_name}**. To move the link, ask an admin to clear it first.`);
        }
        return reply(
            '🔗 **Linking your Discord to your Hub account**\n' +
            '1. Open the Hub and click **Link Discord** in the sidebar.\n' +
            '2. It shows a one-time code, valid for 10 minutes.\n' +
            '3. Come back here and run `!link <code>` (or `/link code:<code>`).\n\n' +
            'The code is what proves the Hub account is yours — a name alone never did.'
        );
    }

    // Sweep expired rows so a stale code can never be spent.
    try { usersRepo.deleteExpiredLinkCodes(); } catch (_) {}

    const normalised = String(code).trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    const row = usersRepo.getLinkCodeWithUser(normalised);

    if (!row) {
        console.warn(`[Discord] !link refused: ${tag} (${userId}) presented an unknown code.`);
        return reply('❌ That code is not valid. Generate a fresh one in the Hub — codes expire after 10 minutes.');
    }
    if (row.used_at) {
        console.warn(`[Discord] !link refused: ${tag} (${userId}) reused a spent code for '${row.game_name}'.`);
        return reply('❌ That code has already been used. Generate a fresh one in the Hub.');
    }
    if (new Date(row.expires_at).getTime() < Date.now()) {
        return reply('❌ That code has expired. Generate a fresh one in the Hub.');
    }
    if (row.discord_id && row.discord_id !== userId) {
        console.warn(`[Discord] !link refused: ${tag} (${userId}) held a valid code for '${row.game_name}', already linked to ${row.discord_id}.`);
        return reply(`❌ **${row.game_name}** is already linked to another Discord account. An admin has to clear it first.`);
    }
    if (already && already.game_name !== row.game_name) {
        return reply(`❌ Your Discord account is already linked to **${already.game_name}**. One Discord account per Hub account — ask an admin if you need it moved.`);
    }
    if (row.discord_id === userId) {
        usersRepo.markLinkCodeUsed(userId, normalised);
        return reply(`ℹ️ **${row.game_name}** is already linked to you. Nothing to do.`);
    }

    try {
        const link = db.transaction(() => {
            usersRepo.updateUserDiscordLink(userId, username, row.user_id);
            usersRepo.markLinkCodeUsed(userId, normalised);
        });
        link();
        console.log(`[Discord] !link: Hub account '${row.game_name}' linked to ${tag} (${userId}) with a verified code.`);
        return reply(`✅ Linked **${row.game_name}** to <@${userId}>. You'll now be pinged on incoming alerts when you can defend.`);
    } catch (e) {
        console.error('[Discord] !link failed:', e.message);
        return reply('❌ Linking failed. Try again later.');
    }
}

// ─── TIMERS ───────────────────────────────────────────────────────────────────
// These used to be a bare setTimeout: a restart or a deploy dropped every pending one,
// and the acknowledgement said so rather than fixing it. They now live in the
// discord_timers table and are polled by the same minute-resolution scheduler that
// already drives note reminders, so a timer that came due while the bot was down fires
// on the next tick instead of vanishing.
//
// setTimeout also takes a 32-bit delay, so anything past ~24.8 days overflowed and fired
// immediately. The 14-day cap that guarded against that is kept — a stored due time has
// no such limit, but a two-week ping is already at the edge of useful.
const MAX_TIMER_MS = 14 * 24 * 60 * 60 * 1000;

// One shared implementation, called by both the ! command and the slash command.
async function handleTimer({ input, userId, channelId, reply }) {
    if (!input) {
        return reply('❌ Usage: `!timer 10mins` or `!timer 1 hour 8 mins`');
    }
    const delayMs = parseTimerInput(input);
    if (!delayMs) {
        return reply('❌ Invalid format. Use simple relative timings like `10mins`, `1h 8m`, or `1 hour 5 minutes`.');
    }
    if (delayMs > MAX_TIMER_MS) {
        return reply('❌ That is too far out. The longest timer is **14 days**.');
    }

    const dueAt = new Date(Date.now() + delayMs);
    try {
        discordTimersRepo.insertTimer(userId, channelId, String(input).slice(0, 200), dueAt.toISOString());
    } catch (err) {
        console.error('[Discord] Could not store timer:', err.message);
        return reply('❌ Could not save that timer. Try again.');
    }

    const unix = Math.floor(dueAt.getTime() / 1000);
    // The resolution is honest: the scheduler ticks once a minute, so say so rather than
    // implying second accuracy the storage does not provide.
    return reply(`⏰ Timer set for <t:${unix}:t> (<t:${unix}:R>). It survives a bot restart; the check runs once a minute, so expect it within a minute of that time.`);
}

// Polled from the same minute tick as note reminders. Anything due — including anything
// that came due while the process was not running — fires here.
async function checkDueTimers() {
    let due;
    try {
        due = discordTimersRepo.getDueTimers(new Date().toISOString());
    } catch (err) {
        console.error('[Discord] Timer lookup failed:', err.message);
        return;
    }
    if (!due.length) return;

    for (const t of due) {
        try {
            const channel = await client.channels.fetch(t.channel_id);
            if (channel && typeof channel.send === 'function') {
                const late = Date.now() - new Date(t.due_at).getTime();
                // If the bot was down, say so instead of pretending it was on time.
                const lateNote = late > 120000 ? ` _(fired ${Math.round(late / 60000)} min late — the bot was not running)_` : '';
                await channel.send(`🔔 <@${t.discord_user_id}> **TIME IS UP!** Your timer for "${t.label}" has finished.${lateNote}`);
            }
        } catch (err) {
            // A deleted channel must not stop the rest of the queue, and must not leave
            // this row to be retried forever.
            console.error(`[Discord] Timer ${t.id} ping failed:`, err.message);
        } finally {
            discordTimersRepo.markTimerFired(t.id);
        }
    }
}

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

// Channels (IDs, separated by commas/spaces/newlines) where the bot refuses to run
// commands — e.g. public/guest channels. Managed from the admin tool via the
// app_settings key 'discord_blocked_channels'. getSettingValue is hoisted below.
function getBlockedChannels() {
    const raw = getSettingValue('discord_blocked_channels');
    return raw ? raw.split(/[^0-9]+/).filter(Boolean) : [];
}

// Harmless glitch-gibberish reply for a command used in a blocked channel. Randomised
// so it varies each time and never echoes anything about the actual command set.
function garble() {
    const bursts = ['bzzt', 'kffzt', 'ghhrkk', 'vrrrt', '*static*', '—click—', 'sssk', 'wrrp', 'zzkt'];
    const techno = ['SIGNAL CORRUPTED', 'UNAUTHORIZED FREQUENCY', 'CARRIER LOST', 'DECODER MISALIGNED',
                    'PACKET SCRAMBLED', 'NULL ROUTE', 'TELEMETRY JAMMED', 'HANDSHAKE REJECTED'];
    const glitch = ['▓', '▒', '░', '▚', '▞', '╳', '⚡', '✶', '◵', '¤', '∎', '⌗'];
    const pick = a => a[Math.floor(Math.random() * a.length)];
    const sym = n => Array.from({ length: n }, () => pick(glitch)).join('');
    return `🛰️ ${pick(bursts)}— ${sym(3)} ${pick(techno)} ${sym(3)} …${pick(bursts)}… ${pick(bursts)}`;
}

// Extracted from the client.on('messageCreate') callback so the slash-command layer can
// reach exactly the same code. One implementation, two entry points.
async function handleMessage(message) {
    if (message.author.bot) return;
    if (!message.content.startsWith('!')) return;

    // Public/guest channels: emit harmless static instead of processing the command.
    if (getBlockedChannels().includes(message.channel.id)) {
        return message.reply(garble());
    }

    const args = message.content.slice(1).trim().split(/ +/);
    const command = args.shift().toLowerCase();

    // REMOVED: a passive backfill used to sit here, writing this author's numeric Discord
    // id onto any Hub account whose stored discord_name matched their username. That is
    // an automatic link with no proof at all — weaker than the !link it sat beside, and
    // it silently defeated the one-time-code challenge, because anyone who set their
    // Discord username to a member's recorded name got linked by typing any command.
    // Linking now happens only through a code minted in the Hub. See handleLink().

    // ----------------------------------------------------
    // !help - DISPLAY ALL AVAILABLE COMMANDS
    // ----------------------------------------------------
    if (command === 'help') {
        const embed = new EmbedBuilder()
            .setTitle('🛠️ Command Center Help')
            .setDescription('Here is a list of all available commands and how to use them:')
            .setColor('#10b981') // Green color
            .addFields(
                { name: '`!link <hub name>`', value: 'Links your Discord account to your Hub account so you get @pinged on incoming alerts you can defend.\n*Example: `!link caveman`*' },
                { name: '`!intels`', value: 'Opens an interactive text menu to browse tracked intelligence profiles.' },
                { name: '`!sys <system_id>`', value: 'Displays intel for a specific solar system (Planets, Fleets, Plans).\n*Example: `!sys 123`*' },
                { name: '`!intel <player_name>`', value: 'Displays detailed intelligence and stats for a specific player.\n*Example: `!intel PlayerOne`*' },
                { name: '`!dist <sys1_id> <sys2_id>`', value: 'Calculates the distance and required biology level between two systems.\n*Example: `!dist 100 200`*' },
                { name: '`!plan <sys_id> <planet_num> <instructions...>`', value: 'Adds a tactical plan/note to a specific planet. (Requires your Discord ID to be linked in the Hub).\n*Example: `!plan 123 4 Send colony ship`*' },
                { name: '`!vision <system_id> [alliance_tag]`', value: 'Performs a radar scan to see which alliance members have vision over a target system.\n*Example: `!vision 123 RAID`*' },
                { name: '`!holes [alliance_tag]`', value: 'Scans your alliance\'s territory to find empty planets, hostile threats, and planned slots.\n*Example: `!holes RAID`*' },
                { name: '`!tt <sysA> <plnA> <sysB> <plnB> <speed> <nrg>`', value: 'Calculates fleet travel time between two coordinates.\n*Example: `!tt 100 1 200 4 10 5`*\n*(You can also swap speed/energy for a player name: `!tt 100 1 200 4 PlayerOne`)*' },
                { name: '`!ghosts <sys_id> <planet_num> <alliance_tag>`', value: 'Calculates the shortest/longest hidden fleet arrival window from hostile members with radar vision over a system.\n*Example: `!ghosts 1 10 AO`*' },
                { name: '`!bio`', value: 'Generates intelligence alerts highlighting players who possess a +6 biology or science advantage over your personal bio level.' },
                { name: '`!battle <D> <C> <B> vs <D> <C> <B>`', value: 'Simulates a battle. Flags: `--sb N` starbase (0-50), `--dp/--ap N` physics, `--dm/--am N` math, `--dra/--ara N` race atk, `--drd/--ard N` race def, `--dl/--al N` player level. Or `--def Name --atk Name` to auto-fill all stats from DB.\n*Example: `!battle 50 10 0 vs 40 8 2 --dp 5 --ap 3 --dl 12 --al 8`*' },
                { name: '`!mortal` / `!mortalday` / `!mortalweek` `[all|<alliance_tag>]`', value: 'Shows the CV/population-killed battle leaderboards — all-time, last 24 hours, or last 7 days. Defaults to Hub tool users only; `all` lifts that; any alliance tag filters to that alliance (any alliance, not just your own).\n*Example: `!mortalweek nsa`*' },
                { name: '`!lastseen <player_name>`', value: 'Shows up to 5 recent system/planet locations a player was involved in a battle report or News-page bombardment at, on either side, newest first.\n*Example: `!lastseen Hkiller89`*' }
            )
            .setFooter({ text: 'AWT Intelligence Hub' });

        return message.reply({ embeds: [embed] });
    }

    // ----------------------------------------------------
    // !link <hub/game name> - link this Discord account to a Hub account
    // ----------------------------------------------------
    if (command === 'link') {
        return handleLink({
            code: args.join(' ').trim(),
            userId: message.author.id,
            username: message.author.username,
            tag: message.author.tag,
            reply: (text) => message.reply(text),
        });
    }

    // ----------------------------------------------------
    // !getid - DISPLAY CHANNEL ID
    // ----------------------------------------------------
    if (command === 'getid') {
        return message.reply(`The ID of this channel is: **${message.channel.id}**`);
    }

    // ----------------------------------------------------
    // !mortal / !mortalday / !mortalweek - BATTLE CHALLENGE LEADERBOARDS
    // ----------------------------------------------------
    if (command === 'mortal' || command === 'mortalday' || command === 'mortalweek') {
        const now = Date.now();
        const sinceIso = command === 'mortalday' ? new Date(now - 24 * 60 * 60 * 1000).toISOString()
            : command === 'mortalweek' ? new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString()
            : null;
        const label = command === 'mortalday' ? 'Last 24 Hours' : command === 'mortalweek' ? 'Last 7 Days' : 'All Time';

        // Default (no arg): only players linked to a Hub account — actual tool users, not
        // every enemy who ever showed up in a fight. `all` lifts that filter entirely.
        // Anything else is treated as an alliance TAG (not a reserved word) — filters to
        // every player in that alliance, tool user or not. Works for any alliance, not
        // just the caller's own.
        const scopeArg = (args[0] || '').trim();
        let scope = 'members';
        let allianceId = null;
        let scopeLabel = '';
        if (scopeArg.toLowerCase() === 'all') {
            scope = 'all';
            scopeLabel = ' (All Players)';
        } else if (scopeArg) {
            const alliance = alliancesRepo.getAllianceIdByTag(scopeArg);
            if (!alliance) {
                return message.reply(`❌ Unknown alliance tag \`${scopeArg}\`. Usage: \`!${command} [all|<alliance_tag>]\`.`);
            }
            scope = 'alliance';
            allianceId = alliance.id;
            scopeLabel = ` (${scopeArg.toUpperCase()})`;
        }

        const { cv, pop } = battlePointsRepo.getLeaderboards(sinceIso, 10, scope, allianceId);
        const formatLines = (rows, unit) => rows.length
            ? rows.map((r, i) => `**${i + 1}.** ${r.player_name || 'Unknown'} — ${r.points} pts (${r.raw.toLocaleString()} ${unit})`).join('\n')
            : '_No battles recorded yet._';
        const embed = new EmbedBuilder()
            .setTitle(`⚔️ Battle Challenge — ${label}${scopeLabel}`)
            .addFields(
                { name: '💥 CV Killed', value: formatLines(cv, 'CV') },
                { name: '☠️ Population Killed', value: formatLines(pop, 'pop') },
            )
            .setColor('#e11d48');

        return message.reply({ embeds: [embed] });
    }

    // ----------------------------------------------------
    // !lastseen <name> - RECENT BATTLE/BOMBARDMENT LOCATIONS FOR A PLAYER
    // ----------------------------------------------------
    if (command === 'lastseen') {
        const playerName = args.join(' ');
        if (!playerName) return message.reply('❌ Usage: `!lastseen <player_name>`');

        const player = playersRepo.getPlayerFullByName(playerName);
        if (!player) return message.reply(`❌ Player **${playerName}** not found in the database.`);

        const occurrences = battleReportsRepo.getRecentPlanets(player.id, 5);
        if (!occurrences.length) {
            // hasAnyBattleHistory distinguishes "never in a recorded battle" from "in a
            // battle, but the ship-detail scrape (which is what actually captures the
            // planet) hasn't reached that report yet" — very different situations for the
            // reader, and the second one is fixable with the sidebar Battle Reports sync
            // button rather than meaning the data is simply missing.
            if (battleReportsRepo.hasAnyBattleHistory(player.id)) {
                return message.reply(`👀 **${player.name}** has battle history, but no location has been scraped yet — try the sidebar's "Battle Reports" sync, ship-detail scraping runs shortly after.`);
            }
            return message.reply(`👀 No battle-report or News-page location on record for **${player.name}** yet.`);
        }

        // "[272] Pherkad Minor #5" — system id in brackets (always known), then the
        // planets table's own name plus its index (both best-effort: a planet that was
        // never scanned into that table falls back to just the numbers).
        function planetLabel(occ) {
            const sysId = occ.system_id;
            let index = occ.planet_index;
            let name = index != null ? systemsRepo.getPlanetNameByLocation(sysId, index) : null;
            if (index == null && occ.game_planet_id != null) {
                const loc = systemsRepo.getPlanetLocationByGameId(occ.game_planet_id);
                if (loc) { index = loc.planet_index; name = loc.name; }
            }
            const nameAndIndex = name && index != null ? `${name} #${index}`
                : index != null ? `Planet #${index}`
                : '(unscanned planet)';
            return `[${sysId}] ${nameAndIndex}`;
        }

        const lines = occurrences.map((occ) => {
            const when = `<t:${Math.floor(Date.parse(occ.occurred_at) / 1000)}:R>`;
            const where = planetLabel(occ);
            if (occ.source === 'battle_report') {
                return `**${where}** — [Battle report #${occ.source_id}](https://astrowars.games/About/BattleReport/${occ.source_id}) — ${when}`;
            }
            // News-page events other than a bombardment (battle-conquer/battle-conquered)
            // never carry credited_player_id/population_delta — no opponent link exists on
            // those rows at all (see news-battle-events.js), and they only ever surface
            // here for the scraping member's OWN record, so no name is needed either.
            if (occ.message_type === 'battle-conquer') {
                return `**${where}** — conquered this planet — ${when}`;
            }
            if (occ.message_type === 'battle-conquered') {
                return `**${where}** — lost this planet — ${when}`;
            }
            const credited = occ.credited_player_id != null ? playersRepo.getPlayerName(occ.credited_player_id) : null;
            const creditedName = credited ? credited.name : 'Unknown';
            const pop = occ.population_delta != null ? occ.population_delta.toLocaleString() : '?';
            return `**${where}** — **${creditedName}** popkilled **${pop}** population — ${when}`;
        });

        const embed = new EmbedBuilder()
            .setTitle(`👀 Last Seen — ${player.name}`)
            .setDescription(lines.join('\n'))
            .setColor('#e11d48');

        return message.reply({ embeds: [embed] });
    }

    // ----------------------------------------------------
    // !timer - SET A CUSTOM TIMER TO PING YOU BACK
    // ----------------------------------------------------

    if (message.content.startsWith('!timer ')) {
        const args = message.content.slice(7).trim(); // Strip away "!timer "
        return handleTimer({
            input: args,
            userId: message.author.id,
            channelId: message.channel.id,
            reply: (text) => message.reply(text),
        });
    }

    // ----------------------------------------------------
    // !bio - BIOLOGY THREAT MATRIX
    // ----------------------------------------------------
    if (command === 'bio') {
        const discordName = message.author.username;
        
        // Find the linked user session mapping
        const user = usersRepo.getUserByDiscordName(discordName.toLowerCase(), `@${discordName.toLowerCase()}`);

        if (!user) {
            return message.reply(`❌ Your Discord username (\`${discordName}\`) is not linked to any Hub account. Add it in the Command Center first.`);
        }

        // Pull the author's own recorded profiles to extract baseline values
        const me = playersRepo.getPlayerBiologyByName(user.game_name.toLowerCase());
        if (!me) {
            return message.reply(`❌ Could not locate your player profile data (\`${user.game_name}\`) in the synced database tracking array. Please scan your profile in-game first.`);
        }

        const myBio = me.biology || 0;
        const threatThreshold = myBio + 6;

        // 1. Confirmed High Biology (has_intel = 1) -> Match bio directly
        const confirmedThreats = playersRepo.getThreatPlayersByBiology(threatThreshold, me.id);

        // 2. Suspected High Biology (has_intel = 0) -> Match science level as proxy ceiling
        const suspectedThreats = playersRepo.getThreatPlayersByScience(threatThreshold, me.id);

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
            const player = playersRepo.getPlayerTravelStatsByName(playerName);
            
            if (!player) {
                return message.reply(`❌ Player **${playerName}** not found in the database. Please provide valid stats manually or check the spelling.`);
            }
            
            speed = player.race_speed || 0;
            energy = player.energy || 0;
            playerNameDisplay = player.name;
        }

        const sys1 = systemsRepo.getSystemCoords(sysA);
        const sys2 = systemsRepo.getSystemCoords(sysB);

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
        const alliancesWithIntel = alliancesRepo.getWarRoomAllianceIntelTags();

        // FIXED: Added missing 'p' alias to prevent SQLITE_ERROR
        const solosCount = playersRepo.countUnaffiliatedIntelPlayers();

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
                    groupPlayers = playersRepo.listUnaffiliatedIntelPlayers();
                } else {
                    groupPlayers = playersRepo.listAllianceIntelPlayers(chosenGroup.id);
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
                
                const player = playersRepo.getPlayerFullById(targetPlayer.id);

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

        const sys = systemsRepo.getFullSystem(sysId);
        if (!sys) return message.reply(`❌ System #${sysId} is not in the Hub database. Scan it in-game first.`);

        const planets = systemsRepo.getSystemPlanetsForBot(sysId);
        const plans = plansRepo.getPlansForSystemForBot(sysId);
        const fleets = fleetsRepo.getFleetsForSystemFull(sysId);

        const systemUrl = process.env.PROXY_DOMAIN
            ? `https://${process.env.PROXY_DOMAIN}/Game/Map/SolarSystem/${sysId}`
            : null;

        // Monospace table: a header row + aligned columns. Every column except the last
        // is padded to a fixed width (over-long cells truncated with …); the last column
        // is free-width. NOTE: code blocks don't render <t:> timestamps or mentions, so
        // fleet ETAs use a plain relative string instead.
        const makeTable = (headers, widths, rows) => {
            const line = (cells) => cells.map((c, i) => {
                const s = String(c == null ? '' : c);
                if (i === widths.length - 1) return s; // last column: no padding
                return s.length > widths[i] ? s.slice(0, Math.max(1, widths[i] - 1)) + '…' : s.padEnd(widths[i]);
            }).join(' ');
            return '```\n' + [line(headers), ...rows.map(line)].join('\n') + '\n```';
        };

        const shipStr = (f) => {
            const parts = [];
            if (f.transports) parts.push(`${f.transports}TR`);
            if (f.colony_ships) parts.push(`${f.colony_ships}CS`);
            if (f.destroyers) parts.push(`${f.destroyers}DS`);
            if (f.cruisers) parts.push(`${f.cruisers}CR`);
            if (f.battleships) parts.push(`${f.battleships}BS`);
            return parts.join(' ');
        };
        const embeds = [];

        // --- PLANETS (green) ---
        if (planets.length > 0) {
            const rows = planets.map(p => {
                return [
                    p.planet_index,
                    p.owner_name ? (p.ally_tag || '?') : '',
                    p.owner_name || '',
                    p.population || 0,
                    p.starbase || 0
                ];
            });
            embeds.push(new EmbedBuilder().setColor('#22c55e').addFields({
                name: '🪐 Planets',
                value: makeTable(['#', 'tag', 'name', 'p', 'sb'], [3, 4, 9, 3, 0], rows)
            }));
        }

        // --- PLANS (amber) ---
        if (plans.length > 0) {
            const sorted = [...plans].sort((a, b) => (a.planet_index || 0) - (b.planet_index || 0));
            const rows = sorted.map(pl => [pl.planet_index, pl.author_name || 'Unknown', pl.note]);
            embeds.push(new EmbedBuilder().setColor('#f59e0b').addFields({
                name: '📝 Plans',
                value: makeTable(['#', 'name', 'plan'], [3, 9, 0], rows)
            }));
        }

        // --- FLEETS (blue) ---
        // Free-text lines (not a rigid table): ship lists vary a lot in length and a wide
        // table wraps mid-column. Markdown rendering also lets in-flight ETAs use a live
        // <t:> timestamp (code blocks can't render those).
        if (fleets.length > 0) {
            const sorted = [...fleets].sort((a, b) => (a.planet_index || 0) - (b.planet_index || 0));
            let body = '';
            sorted.forEach(f => {
                const cv = battleModel.cvOf(f);
                const owner = f.owner_name ? `[${f.ally_tag || '?'}] ${f.owner_name}` : 'Unknown';
                let eta = '🛰️ orbit';
                if (f.arrival_at) {
                    const ts = Math.floor(Date.parse(f.arrival_at) / 1000);
                    eta = !isNaN(ts) ? `➡️ <t:${ts}:R>` : '➡️ moving';
                }
                const ships = shipStr(f);
                body += `**#${f.planet_index}** ${owner} — **${cv.toLocaleString()} CV** · ${eta}${ships ? `\n${ships}` : ''}\n`;
            });
            embeds.push(new EmbedBuilder().setColor('#3b82f6')
                .addFields({ name: '🚀 Fleets', value: body }));
        }

        // Title + clickable link live on the first card.
        const header = embeds[0] || new EmbedBuilder().setColor('#22c55e');
        header.setTitle(`📡 ${sys.name || 'Unknown'} #${sysId} (${sys.x != null ? sys.x : '--'} / ${sys.y != null ? sys.y : '--'})`);
        if (systemUrl) header.setURL(systemUrl);
        if (embeds.length === 0) {
            header.setDescription('*No planets, plans, or fleets recorded for this system.*');
            embeds.push(header);
        }

        return message.reply({ embeds });
    }

    // ----------------------------------------------------
    // !intel <name> - DISPLAY PLAYER INTEL
    // ----------------------------------------------------
    if (command === 'intel') {
        const playerName = args.join(' ');
        if (!playerName) return message.reply('❌ Usage: `!intel <player_name>`');

        const player = playersRepo.getPlayerFullByName(playerName);

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

            const sciLines = `Bio: **${player.biology}** | Eco: **${player.economy}**\nEne: **${player.energy}** | Mat: **${player.mathematics}**\nPhy: **${player.physics}** | Soc: **${player.social}**`;
            const intelAge = player.intel_updated_at ? (Date.now() - new Date(player.intel_updated_at).getTime()) : Infinity;
            const intelTs = player.intel_updated_at ? Math.floor(new Date(player.intel_updated_at).getTime() / 1000) : null;
            if (intelAge > 24 * 60 * 60 * 1000) {
                raceStatsVal += `\n\n**Sciences** ⚠️ as of <t:${intelTs}:R>\n${sciLines}`;
            } else if (intelAge > 12 * 60 * 60 * 1000) {
                raceStatsVal += `\n\n**Sciences** <t:${intelTs}:R>\n${sciLines}`;
            } else {
                raceStatsVal += `\n\n**Sciences**\n${sciLines}`;
            }
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
                    value: (() => {
                        if (!player.has_intel) {
                            return `Planets: **${player.actual_planets || 0} / --**\nTotal Pop: **${player.actual_pop || 0}**\nTrade Rev: **--**\nArtefact: **--**`;
                        }
                        const infraAge = player.intel_updated_at ? (Date.now() - new Date(player.intel_updated_at).getTime()) : Infinity;
                        const artefactVal = player.artefact && player.artefact !== 'N/A' ? player.artefact : '--';
                        const artefactDisplay = infraAge > 24 * 60 * 60 * 1000 ? `${artefactVal} ❓` : artefactVal;
                        return `Planets: **${player.actual_planets || 0} / ${player.culture_level}**\nTotal Pop: **${player.actual_pop || 0}**\nTrade Rev: **${(player.trade_revenue || 0).toLocaleString()}**\nArtefact: **${artefactDisplay}**`;
                    })(),
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

        const sys1 = systemsRepo.getSystemCoords(id1);
        const sys2 = systemsRepo.getSystemCoords(id2);

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
        const user = usersRepo.getUserByDiscordName(discordName.toLowerCase(), `@${discordName.toLowerCase()}`);

        if (!user) {
            return message.reply(`❌ Your Discord username (\`${discordName}\`) is not linked to any Hub account. Add it in the Command Center first.`);
        }

        try {
            plansRepo.createPlan(sysId, pIdx, user.id, note);
            
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

        const targetSys = systemsRepo.getSystemCoords(targetSysId);
        if (!targetSys) return message.reply(`❌ System **[${targetSysId}]** not found in the database. Scan or fly near it first.`);

        const players = playersRepo.getAllianceOriginPlayersBrief(tag);

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
            const userAlliance = usersRepo.getUserAllianceTagByDiscordName(discordName.toLowerCase(), `@${discordName.toLowerCase()}`);

            if (!userAlliance || !userAlliance.tag) {
                return message.reply(`❌ Could not automatically detect your alliance. Provide it explicitly: \`!holes <tag>\``);
            }
            tag = userAlliance.tag.toUpperCase();
        }

        // FETCHES BOTH OWNER NAME AND OWNER ALLIANCE TAG FOR COMPREHENSIVE SECTOR SCANNING
        const rows = systemsRepo.getPlanetsForAllianceTag(tag);

        const planRows = plansRepo.getAllPlanIndex();

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

        const targetSys = systemsRepo.getSystemCoords(sysId);
        if (!targetSys) return message.reply(`❌ System **[${sysId}]** not found in the database.`);

        // Find all players in that alliance with an origin system recorded
        const alliancePlayers = playersRepo.getAllianceOriginPlayersDetailed(tag);

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

            const scrapedPlanets = systemsRepo.getPlanetCoordsForPlayer(p.id);

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

    // ----------------------------------------------------
    // !battle - COMBAT SIMULATOR
    // Syntax: !battle <defD> <defC> <defB> vs <atkD> <atkC> <atkB> [opts]
    // Options: --sb N  (defender starbase level, 0-5)
    //          --dp N  (defender physics 0-10)
    //          --ap N  (attacker physics 0-10)
    //          --dra N (defender race atk mod -4..+4)
    //          --ara N (attacker race atk mod -4..+4)
    //          --drd N (defender race def mod -4..+4)
    //          --ard N (attacker race def mod -4..+4)
    //          --def PlayerName  (auto-fill defender mods from DB)
    //          --atk PlayerName  (auto-fill attacker mods from DB)
    // ----------------------------------------------------
    if (command === 'battle') {
        // The model is NOT defined here any more. Until this was fixed the handler carried
        // its own copy, frozen a day before the dashboard was recalibrated against in-game
        // samples, so !battle and the web calculator answered the same fight differently
        // (19.1 pp apart on average, up to 66.7 pp). Both now call battleModel.simulate().
        const { SHIPS, sbCV } = battleModel;
        const SHIP_NAME = SHIPS.map(s => s.name);

        const rawArgs = args.join(' ');

        // Extract named flags before splitting on "vs"
        const optParse = (flag, def) => {
            const m = rawArgs.match(new RegExp(`${flag}\\s+(-?\\d+)`));
            return m ? parseInt(m[1], 10) : def;
        };
        const strParse = (flag) => {
            const m = rawArgs.match(new RegExp(`${flag}\\s+([A-Za-z][\\w\\s]*?)(?=--|$)`));
            return m ? m[1].trim() : null;
        };

        // Ranges come from the model, not from here. This handler used to cap science at
        // 10 while the web calculator capped it at 30, so `--dp 20` reached the model as
        // two different numbers depending on where you asked.
        const { clampScience: sci, clampRace: race, clampStarbase: sb, clampLevel: lvl } = battleModel;
        const sbLevel  = sb(optParse('--sb',  0));
        let defPhys    = sci(optParse('--dp',  0));
        let atkPhys    = sci(optParse('--ap',  0));
        let defRaceAtk = race(optParse('--dra', 0));
        let atkRaceAtk = race(optParse('--ara', 0));
        let defRaceDef = race(optParse('--drd', 0));
        let atkRaceDef = race(optParse('--ard', 0));
        let defMath    = sci(optParse('--dm',  0));
        let atkMath    = sci(optParse('--am',  0));
        let defLevel   = lvl(optParse('--dl', 0));
        let atkLevel   = lvl(optParse('--al', 0));
        const defPlayerName = strParse('--def');
        const atkPlayerName = strParse('--atk');

        // Auto-fill mods from DB if player names given
        let defPlayerLabel = null, atkPlayerLabel = null;
        if (defPlayerName) {
            const p = playersRepo.getPlayerCombatStats(defPlayerName);
            if (p) {
                defPhys    = sci(p.physics || 0);
                defMath    = sci(p.mathematics || 0);
                defRaceAtk = race(p.race_attack || 0);
                defRaceDef = race(p.race_defense || 0);
                defLevel   = lvl(p.level || 0);
                defPlayerLabel = p.name;
            }
        }
        if (atkPlayerName) {
            const p = playersRepo.getPlayerCombatStats(atkPlayerName);
            if (p) {
                atkPhys    = sci(p.physics || 0);
                atkMath    = sci(p.mathematics || 0);
                atkRaceAtk = race(p.race_attack || 0);
                atkRaceDef = race(p.race_defense || 0);
                atkLevel   = lvl(p.level || 0);
                atkPlayerLabel = p.name;
            }
        }

        // Strip flags from the raw string and split on "vs"
        const stripped = rawArgs.replace(/--\w+\s+[\w\s]*/g, '').trim();
        const vsSplit = stripped.split(/\bvs\b/i);
        if (vsSplit.length !== 2) {
            return message.reply('❌ **Usage:** `!battle <D> <C> <B> vs <D> <C> <B> [--sb N] [--dp N] [--ap N] [--dm N] [--am N] [--dra N] [--ara N] [--drd N] [--ard N]`\nOr: `!battle <D> <C> <B> vs <D> <C> <B> --def DefenderName --atk AttackerName`');
        }

        const parseFleet = str => str.trim().split(/\s+/).map(Number).filter(n => !isNaN(n));
        const defParts = parseFleet(vsSplit[0]);
        const atkParts = parseFleet(vsSplit[1]);

        const defFleet = [defParts[0] || 0, defParts[1] || 0, defParts[2] || 0];
        const atkFleet = [atkParts[0] || 0, atkParts[1] || 0, atkParts[2] || 0];

        const battleInputs = battleModel.normalizeInputs({
            defFleet, atkFleet, sbLevel,
            def: { phys: defPhys, math: defMath, ra: defRaceAtk, rd: defRaceDef, lvl: defLevel },
            atk: { phys: atkPhys, math: atkMath, ra: atkRaceAtk, rd: atkRaceDef, lvl: atkLevel }
        });
        const sim = battleModel.simulate(battleInputs);
        if (sim) { sim.defStats = battleInputs.def; sim.atkStats = battleInputs.atk; }
        if (!sim) {
            return message.reply('❌ Both fleets are empty.');
        }
        const { survDef, survAtk, survSB, initCVD, initCVA, winD, winA } = sim;

        // Format helpers. The win chance is printed as a RANGE: the model is a regression
        // fit whose worst recorded error is ±4 points, so a figure like "47.3%" claims a
        // precision it does not have. Same helper as the web calculator, so the two
        // surfaces cannot describe their confidence differently either.
        const bandDef = battleModel.winBand(winD, { sbLevel, defFleet, def: sim.defStats, atk: sim.atkStats });
        const bandAtk = battleModel.winBand(winA, { sbLevel, defFleet, def: sim.defStats, atk: sim.atkStats });
        const pct = n => (n * 100).toFixed(1) + '%';
        const fmt = n => n % 1 === 0 ? n.toString() : n.toFixed(2).replace(/\.?0+$/, '');
        const shipLine = (fleet, surv, label) => {
            const parts = [];
            fleet.forEach((n, i) => {
                if (n > 0) parts.push(`${SHIP_NAME[i]}: ${fmt(n)} → **${fmt(surv[i])}**`);
            });
            if (sbLevel > 0 && label === 'Defender') {
                const sbSurv = survSB * 1;
                parts.push(`Starbase (lvl ${sbLevel}): 1 → **${fmt(sbSurv)}**`);
            }
            return parts.length ? parts.join('\n') : '*No ships*';
        };

        const defCVRemain = sim.cvDefRemain;
        const atkCVRemain = sim.cvAtkRemain;

        const defLabel = defPlayerLabel ? `Defender (${defPlayerLabel})` : 'Defender';
        const atkLabel = atkPlayerLabel ? `Attacker (${atkPlayerLabel})` : 'Attacker';

        const winColor = winD > 0.65 ? '#22c55e' : winA > 0.65 ? '#ef4444' : '#f59e0b';

        const embed = new EmbedBuilder()
            .setTitle('⚔️ Battle Simulation')
            .setColor(winColor)
            .addFields(
                {
                    name: `🛡️ ${defLabel}`,
                    value: shipLine(defFleet, survDef, 'Defender') +
                           `\n**CV:** ${initCVD.toLocaleString()} → ${fmt(defCVRemain)}` +
                           (defRaceDef !== 0 ? `\nRace Def: **${defRaceDef > 0 ? '+' : ''}${defRaceDef}**` : '') +
                           (defMath    !== 0 ? `\nMath: **${defMath}**` : '') +
                           (defPhys !== 0 ? `\nPhysics: **${defPhys}**` : '') +
                           (defRaceAtk !== 0 ? `\nRace Atk: **${defRaceAtk > 0 ? '+' : ''}${defRaceAtk}**` : '') +
                           (defLevel !== 0 ? `\nLevel: **${defLevel}**` : ''),
                    inline: true,
                },
                {
                    name: `🚀 ${atkLabel}`,
                    value: shipLine(atkFleet, survAtk, 'Attacker') +
                           `\n**CV:** ${initCVA.toLocaleString()} → ${fmt(atkCVRemain)}` +
                           (atkRaceDef !== 0 ? `\nRace Def: **${atkRaceDef > 0 ? '+' : ''}${atkRaceDef}**` : '') +
                           (atkMath    !== 0 ? `\nMath: **${atkMath}**` : '') +
                           (atkPhys !== 0 ? `\nPhysics: **${atkPhys}**` : '') +
                           (atkRaceAtk !== 0 ? `\nRace Atk: **${atkRaceAtk > 0 ? '+' : ''}${atkRaceAtk}**` : '') +
                           (atkLevel !== 0 ? `\nLevel: **${atkLevel}**` : ''),
                    inline: true,
                },
                {
                    name: '🎲 Estimated outcome',
                    value: `Defender wins: **${bandDef.text}**\nAttacker wins: **${bandAtk.text}**` +
                           (bandDef.caveats.length ? `\n\n⚠️ Wider than usual — ${bandDef.caveats.join('; ')}.` : ''),
                    inline: false,
                }
            )
            .setFooter({ text: `Ranges, not readings: the model's worst recorded error is ±${battleModel.uncertainty.BASE_ERROR_PP} points. Survivor counts come from a separate formula with no test coverage. Same model as the Hub calculator.` });

        return message.reply({ embeds: [embed] });
    }
}

// A command that throws used to become an unhandled rejection and the bot just went
// quiet. Now the caller is told, and the reason reaches the log.
client.on('messageCreate', (message) => {
    handleMessage(message).catch(err => {
        console.error(`[Discord] Command failed: ${message.content.slice(0, 60)}`, err);
        message.reply('⚠️ That command hit an error. It has been logged.').catch(() => {});
    });
});

// ─── SLASH COMMANDS ───────────────────────────────────────────────────────────
// Registered PER GUILD rather than globally: guild commands appear immediately, global
// ones take up to an hour to propagate, which makes them painful to iterate on.
async function registerSlashCommands() {
    if (!client.isReady()) return;
    const commands = buildCommands().map(c => c.toJSON());
    let ok = 0;
    for (const [, guild] of client.guilds.cache) {
        try {
            await guild.commands.set(commands);
            ok++;
        } catch (err) {
            console.error(`[Discord] Could not register slash commands in ${guild.name}:`, err.message);
        }
    }
    console.log(`[Discord] Slash commands registered in ${ok}/${client.guilds.cache.size} guild(s).`);
}

// Turn an interaction into the message-shaped object handleMessage() expects, so a slash
// command runs the SAME code as its ! twin instead of a parallel implementation.
function interactionAsMessage(interaction, content) {
    let replied = false;
    return {
        content,
        author: interaction.user,
        channel: interaction.channel,
        member: interaction.member,
        guild: interaction.guild,
        async reply(payload) {
            const body = typeof payload === 'string' ? { content: payload } : payload;
            if (!replied) {
                replied = true;
                if (interaction.deferred) return interaction.editReply(body);
                return interaction.reply(body);
            }
            return interaction.followUp(body);
        },
    };
}

// Map a slash invocation onto the equivalent ! string. The mapping lives in one place so
// the two entry points cannot drift.
// Autocompleted options whose value is a SYSTEM id. Everything else that is
// autocompleted is a player name. Keep this in step with src/discord-commands.js — the
// test asserts the two agree, so adding an option there without adding it here fails the
// build rather than quietly suggesting the wrong list.
const SYSTEM_OPTION_NAMES = new Set(['system', 'from', 'to']);

function slashToPrefix(interaction) {
    const name = interaction.commandName;
    const sub = interaction.options.getSubcommand(false);
    const s = (key) => interaction.options.getString(key);
    const i = (key) => interaction.options.getInteger(key);

    if (name === 'help') return '!help';
    if (name === 'intel') {
        if (sub === 'player') return `!intel ${s('player')}`;
        if (sub === 'system') return `!sys ${s('system')}`;
        if (sub === 'bio') return '!bio';
        if (sub === 'alliance') return '!intels';
    }
    if (name === 'calc') {
        if (sub === 'travel') {
            // !tt reads six positional arguments:
            //   sysA planetA sysB planetB speed energy
            // or five, where the fifth is a player name to take speed and energy from.
            //
            // This used to emit `!tt <from> <to> [energy] [speed]` — no planets at all, so
            // the destination system landed in planetA, the energy in sysB, and the whole
            // thing either failed the usage check or answered for a route nobody asked
            // about. The order was inverted as well: !tt takes speed BEFORE energy.
            const parts = ['!tt', s('from'), String(i('from_planet')), s('to'), String(i('to_planet'))];
            const player = s('player');
            if (player) {
                // Semi-manual form. A player name goes last and may contain spaces; !tt
                // joins everything from the fifth argument on, so this stays one field.
                parts.push(player);
            } else {
                // Manual form. Both numbers are required together — !tt only takes the
                // manual branch when BOTH the fifth and sixth arguments parse as numbers,
                // so sending one alone would silently be read as a player name.
                parts.push(String(i('speed') ?? 0), String(i('energy') ?? 0));
            }
            return parts.join(' ');
        }
        if (sub === 'distance') return `!dist ${s('from')} ${s('to')}`;
        if (sub === 'battle') {
            const flags = [];
            if (i('starbase') != null) flags.push(`--sb ${i('starbase')}`);
            if (s('defender_player')) flags.push(`--def ${s('defender_player')}`);
            if (s('attacker_player')) flags.push(`--atk ${s('attacker_player')}`);
            return `!battle ${s('defender')} vs ${s('attacker')} ${flags.join(' ')}`.trim();
        }
    }
    if (name === 'plan') {
        if (sub === 'add') return `!plan ${s('system')} ${i('planet')} ${s('note')}`;
        if (sub === 'list') return `!sys ${s('system')}`;
    }
    if (name === 'scan') {
        if (sub === 'holes') return '!holes';
        if (sub === 'vision') return `!vision ${s('system')}`;
        if (sub === 'ghosts') return `!ghosts ${s('system')} ${i('planet')} ${s('tag')}`;
    }
    return null;
}

client.on('interactionCreate', async (interaction) => {
    try {
        if (interaction.isAutocomplete()) {
            const focused = interaction.options.getFocused(true);
            // Matched exactly, not by substring. The old /system|from|to/ would have
            // claimed an option called "to_planet" the moment one existed, and answered a
            // planet index with a list of solar systems.
            const choices = SYSTEM_OPTION_NAMES.has(focused.name)
                ? suggestSystems(focused.value)
                : suggestPlayers(focused.value);
            return interaction.respond(choices);
        }
        if (!interaction.isChatInputCommand()) return;

        const sub = interaction.options.getSubcommand(false);
        const ephemeral = isEphemeral(interaction.commandName, sub);

        // Per-command handling for the two that have their own shared implementation.
        if (interaction.commandName === 'timer') {
            await interaction.deferReply({ flags: ephemeral ? MessageFlags.Ephemeral : undefined });
            return handleTimer({
                input: interaction.options.getString('when'),
                userId: interaction.user.id,
                channelId: interaction.channelId,
                reply: (text) => interaction.editReply(typeof text === 'string' ? { content: text } : text),
            });
        }
        if (interaction.commandName === 'link') {
            // Always ephemeral: a link code should not be readable by the channel.
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            return handleLink({
                code: interaction.options.getString('code') || '',
                userId: interaction.user.id,
                username: interaction.user.username,
                tag: interaction.user.tag,
                reply: (text) => interaction.editReply(typeof text === 'string' ? { content: text } : text),
            });
        }

        const asPrefix = slashToPrefix(interaction);
        if (!asPrefix) {
            return interaction.reply({ content: '⚠️ That command is not wired up yet.', flags: MessageFlags.Ephemeral });
        }
        await interaction.deferReply({ flags: ephemeral ? MessageFlags.Ephemeral : undefined });
        await handleMessage(interactionAsMessage(interaction, asPrefix));
    } catch (err) {
        console.error('[Discord] Interaction failed:', err);
        const body = { content: '⚠️ That command hit an error. It has been logged.', flags: MessageFlags.Ephemeral };
        try {
            if (interaction.deferred || interaction.replied) await interaction.followUp(body);
            else await interaction.reply(body);
        } catch (_) { /* the interaction token can expire; nothing more to do */ }
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
    return client;
}

// ----------------------------------------------------
// SYSTEM CHANGE ANNOUNCER (used by the galaxy scanner)
// ----------------------------------------------------
function getSettingValue(key) {
    try {
        const row = settingsRepo.getSetting(key);
        const v = row && row.value ? row.value.trim() : '';
        return v || null;
    } catch (err) {
        return null;
    }
}

function getAnnounceChannelId() {
    return getSettingValue('discord_announce_channel');
}

function getPopdropChannelId() {
    return getSettingValue('discord_popdrop_channel');
}

function getReminderChannelId() {
    return getSettingValue('discord_reminder_channel');
}

// ----------------------------------------------------
// PERSONAL NOTE REMINDERS — "remind 15 min before" mention
// ----------------------------------------------------
// Polled every minute. Picks up notes that are due within 15 minutes (or already
// overdue, e.g. after downtime) and haven't been reminded yet, and pings the owner in
// the configured channel. Best-effort: a note is marked reminded regardless of whether
// the mention could actually be sent (no channel configured / no linked Discord id /
// send failed), so a bad config never causes it to resend forever once fixed.
async function checkNoteReminders() {
    let pending;
    try {
        pending = notesRepo.getDueReminders();
    } catch (err) {
        console.error('[Discord] Reminder lookup failed:', err.message);
        return;
    }
    // due_at is stored as a full ISO string (toISOString()), which SQLite can't compare
    // against datetime('now') (space-separated, no ms) as text — so the 15-minute window
    // is filtered here in JS instead, on parsed Date values.
    const due = pending.filter(n => new Date(n.due_at).getTime() - Date.now() <= 15 * 60 * 1000);
    if (!due.length) return;

    const channelId = getReminderChannelId();
    let channel = null;
    if (client.isReady() && channelId) {
        try { channel = await client.channels.fetch(channelId); } catch (err) {
            console.error('[Discord] Could not fetch reminder channel:', err.message);
        }
    }

    for (const note of due) {
        try {
            if (channel && typeof channel.send === 'function') {
                const unix = Math.floor(new Date(note.due_at).getTime() / 1000);
                const who = note.discord_id ? `<@${note.discord_id}>` : `**${note.game_name}**`;
                const from = note.author_name ? ` _(assigned by ${note.author_name})_` : '';
                await channel.send({ content: `⏰ **Reminder** ${who} — ${note.text}${from}\n🕐 Due <t:${unix}:R>` });
            }
        } catch (err) {
            console.error('[Discord] Failed to send note reminder:', err.message);
        } finally {
            notesRepo.markReminderSent(note.id);
        }
    }
}

// Send one system-change embed to a channel. Best-effort, safe no-op if the channel
// isn't configured / usable. `color` distinguishes owner-change vs pop-drop embeds.
async function sendSystemEmbed(channelId, title, lines, color) {
    if (!channelId || !lines.length) return;
    let channel;
    try {
        channel = await client.channels.fetch(channelId);
    } catch (err) {
        console.error('[Discord] Could not fetch announce channel:', err.message);
        return;
    }
    if (!channel || typeof channel.send !== 'function') return;

    const embed = new EmbedBuilder().setTitle(title).setDescription(lines.join('\n')).setColor(color);
    try {
        await channel.send({ embeds: [embed] });
    } catch (err) {
        console.error('[Discord] Failed to send system change announcement:', err.message);
    }
}

/**
 * Announce planet events detected for a single system. Owner changes go to the
 * "System Change" channel (discord_announce_channel); population drops go to their own
 * "Population Drop" channel (discord_popdrop_channel) so they can be routed separately.
 * `events` is an array of { planet_index, type, old_owner, new_owner, old_pop, new_pop }.
 * Each channel is independent — leaving one empty disables just that stream.
 */
async function announceSystemChanges(system, events) {
    if (!Array.isArray(events) || events.length === 0) return;
    if (!client.isReady()) return;

    const sysLabel = `${system.name ? system.name + ' ' : ''}#${system.id}${(system.x != null && system.y != null) ? ` (${system.x}/${system.y})` : ''}`;

    const ownerLines = events
        .filter(e => e.type === 'OWNER_CHANGE')
        .map(e => `🪐 **Planet ${e.planet_index}**: ${e.old_owner || 'Empty'} → **${e.new_owner || 'Empty'}**`);

    const popLines = events
        .filter(e => e.type === 'POP_DROP')
        .map(e => `📉 **Planet ${e.planet_index}**: population ${e.old_pop} → ${e.new_pop}`);

    await Promise.all([
        sendSystemEmbed(getAnnounceChannelId(), `🛰️ System Change: ${sysLabel}`, ownerLines, '#f59e0b'),
        sendSystemEmbed(getPopdropChannelId(), `📉 Population Drop: ${sysLabel}`, popLines, '#ef4444')
    ]);
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

/**
 * Send OR edit the incoming-attack alert for a given attack identity (alertKey =
 * "system:planet:attacker"). The first call posts a new message and records its id;
 * later calls — whether from the webhook auto-post or the News "announce" button —
 * edit that SAME message. Falls back to a fresh message if the original was deleted or
 * the channel changed. Returns { ok, edited, messageId, channelId }.
 */
async function sendOrEditIncoming(alertKey, content) {
    if (!client.isReady()) return { ok: false, error: 'Discord bot not ready' };
    const channelId = getSettingValue('discord_incoming_channel');
    if (!channelId) return { ok: false, error: 'No incoming channel configured' };

    let channel;
    try {
        channel = await client.channels.fetch(channelId);
    } catch (err) {
        console.error('[Discord] Could not fetch incoming channel:', err.message);
        return { ok: false, error: 'Incoming channel not found' };
    }
    if (!channel || typeof channel.send !== 'function') {
        return { ok: false, error: 'Incoming channel not usable' };
    }

    // Discord hard-caps message content at 2000 chars.
    const text = content.length > 1990 ? content.slice(0, 1987) + '...' : content;

    const record = (msgId) => incomingRepo.upsertMessageRef(alertKey, channelId, msgId);

    // Try to edit the existing alert first (same attack, same channel).
    let existing = null;
    try {
        existing = alertKey != null ? incomingRepo.getMessageRef(alertKey) : null;
    } catch (err) { existing = null; }

    const components = alertKey != null ? [coverButtonRow(alertKey)] : [];

    if (existing && existing.message_id && existing.channel_id === channelId) {
        try {
            const msg = await channel.messages.fetch(existing.message_id);
            await msg.edit({ content: text, components });
            return { ok: true, edited: true, messageId: existing.message_id, channelId };
        } catch (err) {
            // Original gone (deleted/purged) — fall through and post a new one.
            console.warn('[Discord] Could not edit incoming alert, sending new:', err.message);
        }
    }

    try {
        const sent = await channel.send({ content: text, components });
        if (alertKey != null) record(sent.id);
        return { ok: true, edited: false, messageId: sent.id, channelId };
    } catch (err) {
        console.error('[Discord] Failed to send incoming alert:', err.message);
        return { ok: false, error: 'Failed to send message' };
    }
}

/**
 * Re-render just the "Covering:" line on an existing incoming alert (used when a defender
 * claims/retracts from the News panel — the Discord button path edits itself). Reads the
 * current roster from the DB. Best-effort, safe no-op if the message is gone.
 */
async function updateIncomingCover(alertKey) {
    if (!client.isReady() || alertKey == null) return false;
    let row;
    try {
        row = incomingRepo.getMessageRef(alertKey);
    } catch (e) { return false; }
    if (!row || !row.message_id || !row.channel_id) return false;

    let channel;
    try {
        channel = await client.channels.fetch(row.channel_id);
    } catch (err) { return false; }
    if (!channel || typeof channel.messages?.fetch !== 'function') return false;

    try {
        const msg = await channel.messages.fetch(row.message_id);
        const content = applyCoverLine(msg.content, renderCoverLine(getCovering(alertKey)));
        await msg.edit({ content, components: [coverButtonRow(alertKey)] });
        return true;
    } catch (err) {
        console.warn('[Discord] Could not update cover line:', err.message);
        return false;
    }
}

/**
 * Post a reply to an existing message (used to ping newly-available defenders, since
 * editing the main alert never notifies anyone). Best-effort, safe no-op on failure.
 */
async function replyToIncoming(channelId, messageId, content) {
    if (!client.isReady() || !channelId || !messageId) return false;
    let channel;
    try {
        channel = await client.channels.fetch(channelId);
    } catch (err) { return false; }
    if (!channel || typeof channel.send !== 'function') return false;

    const text = content.length > 1990 ? content.slice(0, 1987) + '...' : content;
    try {
        await channel.send({ content: text, reply: { messageReference: messageId, failIfNotExists: false } });
        return true;
    } catch (err) {
        console.error('[Discord] Failed to reply to incoming alert:', err.message);
        return false;
    }
}

module.exports = {
    initDiscordBot, announceSystemChanges, sendIncomingAlert, sendOrEditIncoming,
    replyToIncoming, updateIncomingCover,
    // Exported for the tests: these are the pieces with real logic in them, and they run
    // without a Discord connection.
    handleTimer, checkDueTimers, handleLink, parseTimerInput, slashToPrefix, registerSlashCommands,
    SYSTEM_OPTION_NAMES,
};