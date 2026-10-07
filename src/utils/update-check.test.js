// The update check tells admins when GitHub has AWT changes their hub is not running.
// Pinned here: it reads the running commit correctly from every .git layout a hub can have,
// reads GitHub's compare answer the right way round (GitHub's "ahead" means WE are behind),
// survives every failure without inventing a status, sends nothing when switched off, and
// never reads the git remote (a remote URL can carry a token).
//
// No network: GitHub is a fake fetch. All data synthetic.
//
// Run with: node src/utils/update-check.test.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createUpdateCheck, readGitHead, configFromEnv, summariseCompare, describeCommit, DEFAULT_REPO } = require('./update-check');

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
    if (cond) { pass++; console.log(`  ✅ ${name}`); }
    else { fail++; console.log(`  ❌ ${name}${detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''}`); }
};

const A = 'a'.repeat(40), B = 'b'.repeat(40), C = 'c'.repeat(40);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'awt-update-check-'));
function repo(name, files) {
    const root = path.join(tmp, name);
    for (const [rel, content] of Object.entries(files)) {
        const full = path.join(root, rel);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, content);
    }
    fs.mkdirSync(root, { recursive: true });
    return root;
}

const mergeCommit = (n, title) => ({ commit: { message: `Merge pull request #${n} from someone/branch\n\n${title}` } });
const plainCommit = (msg) => ({ commit: { message: msg } });

function fakeFetch(answer) {
    const calls = [];
    const impl = async (url, init) => {
        calls.push({ url, init });
        if (answer instanceof Error) throw answer;
        return { status: answer.status, ok: answer.status >= 200 && answer.status < 300, json: async () => answer.body };
    };
    return { impl, calls };
}

(async () => {
    console.log('update-check.test.js');

    console.log('\n── reading the running commit from .git ' + '─'.repeat(30));
    ok('a branch with a loose ref', JSON.stringify(readGitHead(repo('loose', { '.git/HEAD': 'ref: refs/heads/main\n', '.git/refs/heads/main': A + '\n' })))
        === JSON.stringify({ sha: A, branch: 'main' }));
    ok('a branch only in packed-refs', JSON.stringify(readGitHead(repo('packed', {
        '.git/HEAD': 'ref: refs/heads/main\n',
        '.git/packed-refs': `# pack-refs with: peeled fully-peeled sorted\n${B} refs/heads/other\n${A} refs/heads/main\n`,
    }))) === JSON.stringify({ sha: A, branch: 'main' }));
    ok('a detached HEAD', JSON.stringify(readGitHead(repo('detached', { '.git/HEAD': C + '\n' }))) === JSON.stringify({ sha: C, branch: null }));
    const shared = repo('shared', { '.git/refs/heads/feature': B + '\n' });
    // A worktree: .git is a file pointing at its own dir, and its refs live in the shared one.
    repo('worktree', { '.git': `gitdir: ${path.join(shared, '.git', 'worktrees', 'wt')}\n` });
    fs.mkdirSync(path.join(shared, '.git', 'worktrees', 'wt'), { recursive: true });
    fs.writeFileSync(path.join(shared, '.git', 'worktrees', 'wt', 'HEAD'), 'ref: refs/heads/feature\n');
    fs.writeFileSync(path.join(shared, '.git', 'worktrees', 'wt', 'commondir'), '../..\n');
    ok('a worktree resolves through commondir', JSON.stringify(readGitHead(path.join(tmp, 'worktree'))) === JSON.stringify({ sha: B, branch: 'feature' }),
        readGitHead(path.join(tmp, 'worktree')));
    ok('no .git at all (a download) is null, not a guess', readGitHead(repo('download', { 'server.js': '' })) === null);
    ok('a HEAD it does not understand is null', readGitHead(repo('weird', { '.git/HEAD': 'nonsense\n' })) === null);
    ok('a branch whose ref is missing is null', readGitHead(repo('noref', { '.git/HEAD': 'ref: refs/heads/main\n' })) === null);

    console.log('\n── configuration ' + '─'.repeat(54));
    ok('on by default, against the canonical repository', JSON.stringify(configFromEnv({})) === JSON.stringify({ enabled: true, repo: DEFAULT_REPO, branch: 'main' }));
    for (const v of ['off', 'OFF', 'false', '0', 'no']) ok(`UPDATE_CHECK=${v} turns it off`, configFromEnv({ UPDATE_CHECK: v }).enabled === false);
    ok('another repository and branch can be named', JSON.stringify(configFromEnv({ UPDATE_CHECK_REPO: 'someone/fork', UPDATE_CHECK_BRANCH: 'stable' }))
        === JSON.stringify({ enabled: true, repo: 'someone/fork', branch: 'stable' }));
    ok('a malformed repository falls back rather than building a strange URL', configFromEnv({ UPDATE_CHECK_REPO: '../../evil?x=' }).repo === DEFAULT_REPO);

    console.log('\n── reading GitHub\'s compare answer ' + '─'.repeat(36));
    ok('a merge commit gives the pull request number and title', JSON.stringify(describeCommit(mergeCommit(335, 'Fix stale scans')))
        === JSON.stringify({ number: 335, title: 'Fix stale scans' }));
    ok('a direct commit gives its first line', JSON.stringify(describeCommit(plainCommit('Tidy docs\n\nlonger body'))) === JSON.stringify({ number: null, title: 'Tidy docs' }));
    ok('"identical" is up to date', summariseCompare({ status: 'identical', ahead_by: 0, behind_by: 0, commits: [] }).status === 'up_to_date');
    const behind = summariseCompare({
        status: 'ahead', ahead_by: 4, behind_by: 0, html_url: 'https://github.com/x/y/compare/a...main',
        commits: [plainCommit('work on 1'), mergeCommit(1, 'First'), plainCommit('work on 2'), mergeCommit(2, 'Second')],
    });
    ok('GitHub "ahead" means THIS hub is behind', behind.status === 'behind' && behind.behind_by === 4, behind);
    ok('it lists pull requests, newest first, not their inner commits',
        JSON.stringify(behind.changes) === JSON.stringify([{ number: 2, title: 'Second' }, { number: 1, title: 'First' }]), behind.changes);
    ok('and links the comparison', behind.compare_url === 'https://github.com/x/y/compare/a...main');
    ok('a link that is not github.com is dropped', summariseCompare({ status: 'ahead', ahead_by: 1, html_url: 'javascript:alert(1)', commits: [] }).compare_url === null);
    ok('GitHub "behind" means local changes, nothing missing', summariseCompare({ status: 'behind', ahead_by: 0, behind_by: 2, commits: [] }).status === 'local_changes');
    ok('"diverged" says how many are missing', (() => { const d = summariseCompare({ status: 'diverged', ahead_by: 3, behind_by: 1, commits: [] }); return d.status === 'diverged' && d.behind_by === 3 && d.ahead_by === 1; })());
    ok('an unknown status is an error, not a guess', summariseCompare({ status: 'mystery' }).status === 'error');
    ok('only the last 15 changes are listed', summariseCompare({ status: 'ahead', ahead_by: 30, commits: Array.from({ length: 30 }, (_, i) => mergeCommit(i + 1, `PR ${i + 1}`)) }).changes.length === 15);

    console.log('\n── the check itself ' + '─'.repeat(51));
    const root = repo('running', { '.git/HEAD': 'ref: refs/heads/main\n', '.git/refs/heads/main': A + '\n' });
    const config = { enabled: true, repo: 'someone/awt', branch: 'main' };
    {
        const gh = fakeFetch({ status: 200, body: { status: 'ahead', ahead_by: 1, behind_by: 0, commits: [mergeCommit(7, 'Seven')] } });
        const check = createUpdateCheck({ config, rootDir: root, fetchImpl: gh.impl });
        ok('before the first check it says so', check.getState().status === 'pending' && check.getState().local_sha === A);
        const state = await check.checkOnce();
        ok('it asks GitHub to compare the running commit with main', gh.calls.length === 1
            && gh.calls[0].url === `https://api.github.com/repos/someone/awt/compare/${A}...main`, gh.calls.map(c => c.url));
        ok('with a User-Agent (GitHub refuses requests without one)', gh.calls[0].init.headers['User-Agent'] === 'awt-update-check');
        ok('and no credentials of any kind', !('Authorization' in gh.calls[0].init.headers) && !('authorization' in gh.calls[0].init.headers));
        ok('it reports the hub one change behind', state.status === 'behind' && state.behind_by === 1 && state.changes[0].title === 'Seven', state);
        ok('and when it checked', typeof state.checked_at === 'string');
    }
    {
        // A pull that has not been restarted onto must not make the hub look up to date.
        const gh = fakeFetch({ status: 200, body: { status: 'identical', commits: [] } });
        const check = createUpdateCheck({ config, rootDir: root, fetchImpl: gh.impl });
        fs.writeFileSync(path.join(root, '.git', 'refs', 'heads', 'main'), B + '\n');
        await check.checkOnce();
        ok('it compares the commit it STARTED on, not one pulled since', gh.calls[0].url.includes(A) && !gh.calls[0].url.includes(B), gh.calls[0].url);
        fs.writeFileSync(path.join(root, '.git', 'refs', 'heads', 'main'), A + '\n');
    }
    {
        const check = createUpdateCheck({ config, rootDir: root, fetchImpl: fakeFetch({ status: 404, body: {} }).impl });
        ok('a commit GitHub does not know is "unknown_commit"', (await check.checkOnce()).status === 'unknown_commit');
    }
    {
        const check = createUpdateCheck({ config, rootDir: root, fetchImpl: fakeFetch({ status: 403, body: {} }).impl });
        const s = await check.checkOnce();
        ok('a refusal (rate limit) is an error with the reason', s.status === 'error' && /403/.test(s.error), s);
    }
    {
        const check = createUpdateCheck({ config, rootDir: root, fetchImpl: fakeFetch(new Error('getaddrinfo ENOTFOUND')).impl });
        const s = await check.checkOnce();
        ok('no network is an error with the reason, not a crash', s.status === 'error' && /ENOTFOUND/.test(s.error), s);
    }
    {
        let answer = { status: 200, body: { status: 'ahead', ahead_by: 2, commits: [] } };
        const impl = async () => ({ status: answer.status, ok: answer.status === 200, json: async () => answer.body });
        const check = createUpdateCheck({ config, rootDir: root, fetchImpl: impl });
        await check.checkOnce();
        answer = { status: 500, body: {} };
        const s = await check.checkOnce();
        ok('a failed re-check keeps the last real answer and adds the error', s.status === 'behind' && s.behind_by === 2 && /500/.test(s.error), s);
    }
    {
        const gh = fakeFetch({ status: 200, body: { status: 'identical' } });
        const off = createUpdateCheck({ config: { ...config, enabled: false }, rootDir: root, fetchImpl: gh.impl });
        await off.checkOnce();
        ok('switched off: nothing is sent, and it says so', gh.calls.length === 0 && off.getState().status === 'disabled');
        const nogit = createUpdateCheck({ config, rootDir: path.join(tmp, 'download'), fetchImpl: gh.impl });
        await nogit.checkOnce();
        ok('without .git: nothing is sent, and it says why', gh.calls.length === 0 && nogit.getState().status === 'no_git');
    }

    console.log('\n── it never reads the git remote ' + '─'.repeat(38));
    const code = fs.readFileSync(path.join(__dirname, 'update-check.js'), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    ok('no read of .git/config (where a remote URL, and a token in it, lives)', !/['"`]config['"`]/.test(code));
    ok('no git binary is run', !/child_process/.test(code));

    fs.rmSync(tmp, { recursive: true, force: true });
    console.log(`\n${pass} passed, ${fail} failed`);
    if (fail) process.exit(1);
})().catch((err) => { console.error('Test run crashed:', err); process.exit(1); });
