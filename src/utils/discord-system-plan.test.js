// !splan end to end — the message-command paths (read / write / delete). The button and
// modal round-trip (the actual "give a text to edit" feature) needs a real gateway
// interaction object discord.js constructs internally and is not driven here; the pure
// pieces it depends on — systemPlansRepo, and the message-command paths that share the same
// admin/link checks as the button handlers — are what this file covers.
//
// Run with: node src/utils/discord-system-plan.test.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awt-system-plan-bot-'));
process.env.AWT_DB_PATH = path.join(testDir, 'test.db');
delete process.env.DISCORD_TOKEN;

const db = require('../database');
const settingsRepo = require('../repositories/settings');
const systemPlansRepo = require('../repositories/systemPlans');
const bot = require('../discord_bot');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
    if (cond) { pass++; console.log(`  ✅ ${name}`); }
    else { fail++; console.log(`  ❌ ${name}${detail === undefined ? '' : `  -> ${JSON.stringify(detail)}`}`); }
}

function capture(content, username) {
    const replies = [];
    const reacts = [];
    return {
        replies, reacts,
        message: {
            content, author: { bot: false, username: username || 'SyntheticUser' },
            channel: { id: 'synthetic-channel' },
            react: async (emoji) => { reacts.push(emoji); },
            reply: async (payload) => { replies.push(payload); },
        },
    };
}
const lastText = (replies) => {
    const last = replies[replies.length - 1];
    if (!last) return '';
    if (typeof last === 'string') return last;
    return last.content || '';
};
const lastEmbeds = (replies) => {
    const last = replies[replies.length - 1];
    return last && last.embeds ? last.embeds.map(e => e.toJSON()) : [];
};
const lastComponents = (replies) => {
    const last = replies[replies.length - 1];
    return last && last.components ? last.components : [];
};

console.log('discord-system-plan.test.js');

db.prepare(`INSERT INTO systems (id, name, x, y) VALUES (700, 'Testoria', 1, 1)`).run();
db.prepare(`INSERT INTO app_users (id, game_name, password_hash, role, discord_name) VALUES (900, 'AdminOne', 'x', 'admin', 'adminuser')`).run();
db.prepare(`INSERT INTO app_users (id, game_name, password_hash, role, discord_name) VALUES (901, 'MemberOne', 'x', 'user', 'memberuser')`).run();

(async () => {
    try {
        console.log('\n── Off by default ' + '─'.repeat(56));
        {
            const c = capture('!splan 700', 'adminuser');
            await bot.handleMessage(c.message);
            ok('reading while off is refused', lastText(c.replies).includes('turned off'), lastText(c.replies));

            const w = capture('!splan 700 We hold this system', 'adminuser');
            await bot.handleMessage(w.message);
            ok('writing while off is refused the same way', lastText(w.replies).includes('turned off'), lastText(w.replies));
        }

        settingsRepo.setSetting('system_plans_enabled', '1');

        console.log('\n── Reading a system with nothing written yet ' + '─'.repeat(29));
        {
            const c = capture('!splan 700', 'memberuser');
            await bot.handleMessage(c.message);
            ok('a non-admin CAN read — same open-read rule as planet_plans',
                lastText(c.replies).includes('No system plan on record'), lastText(c.replies));
        }

        console.log('\n── Only admins can write ' + '─'.repeat(46));
        {
            const c = capture('!splan 700 We hold this system, colony ships inbound', 'memberuser');
            await bot.handleMessage(c.message);
            ok('a linked non-admin is refused', lastText(c.replies).includes('Only admins'), lastText(c.replies));
            ok('and nothing was written', systemPlansRepo.getSystemPlan(700) === null);

            const unlinked = capture('!splan 700 sneaky', 'nobody-linked');
            await bot.handleMessage(unlinked.message);
            ok('an unlinked Discord account is told to link first, not just refused',
                lastText(unlinked.replies).includes('not linked'), lastText(unlinked.replies));
        }

        console.log('\n── An admin writes it ' + '─'.repeat(49));
        {
            const c = capture('!splan 700 We hold this system, colony ships inbound', 'adminuser');
            await bot.handleMessage(c.message);
            ok('confirms success', lastText(c.replies).includes('saved'), lastText(c.replies));
            ok('reacted', c.reacts.includes('✅'), c.reacts);

            const embeds = lastEmbeds(c.replies);
            ok('embed carries the note', embeds[0] && embeds[0].description.includes('colony ships inbound'), embeds[0]);
            ok('footer credits the author and says nothing about editing yet',
                embeds[0] && embeds[0].footer.text.includes('AdminOne') && !embeds[0].footer.text.includes('edited'),
                embeds[0] && embeds[0].footer);

            const components = lastComponents(c.replies);
            ok('an admin writer gets the Edit/Delete buttons on the confirmation',
                components.length === 1, components.length);
        }

        console.log('\n── Reading it back, as a non-admin ' + '─'.repeat(39));
        {
            const c = capture('!splan 700', 'memberuser');
            await bot.handleMessage(c.message);
            const embeds = lastEmbeds(c.replies);
            ok('sees the same note', embeds[0] && embeds[0].description.includes('colony ships inbound'), embeds[0]);

            const components = lastComponents(c.replies);
            ok('but gets no Edit/Delete buttons — only admins may act on them',
                components.length === 0, components.length);
        }

        console.log('\n── Overwriting it (the blunt path, not the Edit button) ' + '─'.repeat(19));
        {
            db.prepare(`UPDATE system_plans SET created_at = datetime(created_at, '-1 minute') WHERE system_id = 700`).run();
            const c = capture('!splan 700 UPDATE: reinforcements arrived', 'adminuser');
            await bot.handleMessage(c.message);
            const embeds = lastEmbeds(c.replies);
            ok('the note is replaced', embeds[0] && embeds[0].description.includes('reinforcements arrived'), embeds[0]);
            ok('now the footer says it was edited', embeds[0] && embeds[0].footer.text.includes('edited'), embeds[0] && embeds[0].footer);
        }

        console.log('\n── A note too long for the Edit modal to ever reopen ' + '─'.repeat(21));
        {
            const tooLong = 'x'.repeat(4001);
            const c = capture(`!splan 700 ${tooLong}`, 'adminuser');
            await bot.handleMessage(c.message);
            ok('is rejected up front, with the character count', lastText(c.replies).includes('4001'), lastText(c.replies));
            ok('and the existing plan is untouched',
                systemPlansRepo.getSystemPlan(700).note.includes('reinforcements arrived'));
        }

        console.log('\n── Deleting it ' + '─'.repeat(59));
        {
            const memberTry = capture('!splan del 700', 'memberuser');
            await bot.handleMessage(memberTry.message);
            ok('a non-admin cannot delete', lastText(memberTry.replies).includes('Only admins'), lastText(memberTry.replies));
            ok('and it is still there', systemPlansRepo.getSystemPlan(700) !== null);

            const c = capture('!splan del 700', 'adminuser');
            await bot.handleMessage(c.message);
            ok('an admin can', lastText(c.replies).includes('removed'), lastText(c.replies));
            ok('it is really gone', systemPlansRepo.getSystemPlan(700) === null);

            const again = capture('!splan del 700', 'adminuser');
            await bot.handleMessage(again.message);
            ok('deleting a system with nothing on record says so rather than a generic error',
                lastText(again.replies).includes('No plan on record'), lastText(again.replies));
        }

        console.log('\n── Usage errors ' + '─'.repeat(58));
        {
            const c = capture('!splan', 'adminuser');
            await bot.handleMessage(c.message);
            ok('a bare !splan with no system id is a usage message, not a crash',
                lastText(c.replies).includes('Usage'), lastText(c.replies));
        }
    } catch (err) {
        fail++;
        console.error('THREW:', err);
    }

    fs.rmSync(testDir, { recursive: true, force: true });

    console.log('\n' + '─'.repeat(75));
    console.log(`${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
})();
