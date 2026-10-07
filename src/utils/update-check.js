// Tells this hub's admins when the AWT repository on GitHub has changes this hub is not
// running yet.
//
// Several alliances run their own copy of this code. A fix that lands here reaches theirs only
// when somebody there updates, and nothing told them it existed. Every UPDATE_CHECK_INTERVAL_MS
// the server asks GitHub's public API how the commit it is running compares with the
// repository's main branch, and the admin page shows the result: how many changes behind, the
// titles of the pull requests it is missing, and the update steps.
//
// It only TELLS. It never updates anything itself. A web process able to rewrite its own code
// and restart itself turns a stolen admin session into control of the server, and a failed
// install would take the hub down with nobody at a terminal.
//
// What leaves the server: one HTTPS request to api.github.com every six hours, carrying the
// commit id this hub runs (GitHub sees the server's IP, as with any request). No account, no
// token, nothing about the alliance or its members. UPDATE_CHECK=off turns it off. The repository
// name comes from configuration, never from the git remote: a remote URL can carry a token.

const fs = require('fs');
const path = require('path');

const DEFAULT_REPO = 'trasher-is/awt';
const DEFAULT_BRANCH = 'main';
const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const FIRST_CHECK_DELAY_MS = 60 * 1000;
const REQUEST_TIMEOUT_MS = 10 * 1000;
const MAX_CHANGES_LISTED = 15;

const SHA = /^[0-9a-f]{40}$/;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const BRANCH = /^[A-Za-z0-9_./-]{1,100}$/;

function readText(file) {
    try { return fs.readFileSync(file, 'utf8').trim(); } catch (err) { return null; }
}

// The commit a checkout is on, read straight from .git (no git binary needed, nothing executed).
// Handles a normal checkout, a worktree (.git is a file pointing elsewhere, refs in the shared
// dir), packed refs and a detached HEAD. Returns { sha, branch } or null when it cannot tell
// (installed from a download, or an unexpected layout).
function readGitHead(rootDir) {
    let gitDir = path.join(rootDir, '.git');
    const pointer = readText(gitDir);
    if (pointer && pointer.startsWith('gitdir:')) {
        gitDir = path.resolve(rootDir, pointer.slice('gitdir:'.length).trim());
    }
    const head = readText(path.join(gitDir, 'HEAD'));
    if (!head) return null;
    if (SHA.test(head)) return { sha: head, branch: null };
    if (!head.startsWith('ref:')) return null;
    const ref = head.slice('ref:'.length).trim();
    const common = readText(path.join(gitDir, 'commondir'));
    const refDirs = [gitDir];
    if (common) refDirs.push(path.resolve(gitDir, common));
    const branch = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
    for (const dir of refDirs) {
        const loose = readText(path.join(dir, ref));
        if (loose && SHA.test(loose)) return { sha: loose, branch };
        const packed = readText(path.join(dir, 'packed-refs'));
        if (packed) {
            for (const line of packed.split('\n')) {
                const [sha, name] = line.trim().split(' ');
                if (name === ref && SHA.test(sha)) return { sha, branch };
            }
        }
    }
    return null;
}

function configFromEnv(env = process.env) {
    const off = /^(off|false|0|no)$/i.test(String(env.UPDATE_CHECK || '').trim());
    const repo = REPO.test(String(env.UPDATE_CHECK_REPO || '')) ? env.UPDATE_CHECK_REPO : DEFAULT_REPO;
    const branch = BRANCH.test(String(env.UPDATE_CHECK_BRANCH || '')) ? env.UPDATE_CHECK_BRANCH : DEFAULT_BRANCH;
    return { enabled: !off, repo, branch };
}

// A merge commit made by GitHub reads "Merge pull request #335 from owner/branch", a blank line,
// then the pull request's title. Anything else is a direct commit: its first line is the title.
function describeCommit(commit) {
    const message = String((commit && commit.commit && commit.commit.message) || '');
    const lines = message.split('\n');
    const merge = /^Merge pull request #(\d+)/.exec(lines[0]);
    if (merge) {
        const title = lines.slice(1).map(l => l.trim()).find(Boolean) || lines[0];
        return { number: Number(merge[1]), title: title.slice(0, 200) };
    }
    return { number: null, title: lines[0].slice(0, 200) };
}

// GitHub's compare answer -> what the admin page shows. In "local...main", "ahead" means main
// has commits this hub lacks.
function summariseCompare(body) {
    const status = body && body.status;
    const commits = Array.isArray(body && body.commits) ? body.commits : [];
    const merges = commits.map(describeCommit).filter(c => c.number !== null);
    // Prefer pull request titles: a merged PR's own commits would otherwise repeat it.
    const changes = (merges.length ? merges : commits.map(describeCommit)).reverse().slice(0, MAX_CHANGES_LISTED);
    const base = {
        behind_by: Number.isInteger(body && body.ahead_by) ? body.ahead_by : 0,
        ahead_by: Number.isInteger(body && body.behind_by) ? body.behind_by : 0,
        compare_url: typeof (body && body.html_url) === 'string' && body.html_url.startsWith('https://github.com/') ? body.html_url : null,
        changes,
    };
    if (status === 'identical') return { ...base, status: 'up_to_date', changes: [] };
    if (status === 'ahead') return { ...base, status: 'behind' };
    if (status === 'behind') return { ...base, status: 'local_changes', changes: [] };
    if (status === 'diverged') return { ...base, status: 'diverged' };
    return { ...base, status: 'error', error: `unexpected compare status ${String(status).slice(0, 40)}` };
}

function createUpdateCheck({ config = configFromEnv(), rootDir = path.join(__dirname, '..', '..'), fetchImpl = globalThis.fetch, now = () => Date.now() } = {}) {
    // Read once: this is the code the process is RUNNING. A `git pull` without a restart moves
    // HEAD but not the running code, and must not make the hub look up to date.
    const local = readGitHead(rootDir);
    let state = {
        enabled: config.enabled, repo: config.repo, branch: config.branch,
        local_sha: local ? local.sha : null, local_branch: local ? local.branch : null,
        status: !config.enabled ? 'disabled' : (local ? 'pending' : 'no_git'),
        behind_by: 0, ahead_by: 0, changes: [], compare_url: null, checked_at: null, error: null,
    };
    let timer = null;

    async function checkOnce() {
        if (!config.enabled || !local) return state;
        const url = `https://api.github.com/repos/${config.repo}/compare/${local.sha}...${encodeURIComponent(config.branch)}`;
        let next;
        try {
            const res = await fetchImpl(url, {
                headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'awt-update-check' },
                signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            });
            if (res.status === 404) {
                // GitHub does not know this commit: local changes that were never pushed there,
                // a fork, or a repository name that is wrong.
                next = { status: 'unknown_commit', behind_by: 0, ahead_by: 0, changes: [], compare_url: null, error: null };
            } else if (!res.ok) {
                next = { ...state, status: state.status === 'pending' ? 'error' : state.status, error: `GitHub answered ${res.status}` };
            } else {
                next = { error: null, ...summariseCompare(await res.json()) };
            }
        } catch (err) {
            next = { ...state, status: state.status === 'pending' ? 'error' : state.status, error: String(err && err.message || err).slice(0, 200) };
        }
        const wasBehind = state.status === 'behind' ? state.behind_by : 0;
        state = { ...state, ...next, checked_at: new Date(now()).toISOString() };
        if (state.status === 'behind' && state.behind_by !== wasBehind) {
            console.log(`[Update] ${state.behind_by} new change(s) on GitHub ${config.repo} ${config.branch} — see the admin page.`);
        } else if (state.error) {
            console.warn(`[Update] check failed: ${state.error}`);
        }
        return state;
    }

    function start() {
        if (!config.enabled || !local || timer) return;
        timer = setTimeout(function tick() {
            checkOnce().finally(() => {
                timer = setTimeout(tick, UPDATE_CHECK_INTERVAL_MS);
                if (timer.unref) timer.unref();
            });
        }, FIRST_CHECK_DELAY_MS);
        if (timer.unref) timer.unref();
    }

    return { checkOnce, start, getState: () => ({ ...state, changes: state.changes.map(c => ({ ...c })) }) };
}

// The one instance the server starts and the admin route reads.
const updateCheck = createUpdateCheck();

module.exports = { createUpdateCheck, updateCheck, readGitHead, configFromEnv, summariseCompare, describeCommit, DEFAULT_REPO };
