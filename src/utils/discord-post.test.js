// Only the token-absent no-op path is testable offline — anything that reaches a real
// Discord REST call needs a live token and network access neither test env has.

delete process.env.DISCORD_TOKEN;
delete process.env.BATTLE_DISCORD_TOKEN;

const { postBattleEmbed } = require('./discord-post');

let failed = 0;
function ok(desc, cond, detail) {
    if (cond) { console.log(`  ok - ${desc}`); }
    else { failed++; console.error(`  NOT OK - ${desc}`, detail !== undefined ? detail : ''); }
}

console.log('discord-post.test.js');

postBattleEmbed('discord_battlepoints_channel', { title: 'test' }).then(result => {
    ok('postBattleEmbed no-ops with a reason when neither token is set',
        result.ok === false && typeof result.reason === 'string', result);

    if (failed > 0) {
        console.error(`${failed} check(s) failed`);
        process.exit(1);
    }
    console.log('All checks passed');
});
