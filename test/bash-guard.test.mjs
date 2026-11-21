// The Bash guard rules, layer by layer. Run: node --test test/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { KIT, git, makeRepo, payload, tmp } from './helpers.mjs';
import { evaluate, ruleFiles } from '../lib/bash-guard/bash-guard.mjs';

const GUARD = join(KIT, 'lib', 'bash-guard', 'bash-guard.mjs');
const ALL = ['core', 'jobs', 'phoenix'];

// phoenix: the deploy rule reads HEAD, the stamp and `git status` from PREDEPLOY_ROOT.
const FIXTURE = makeRepo();
writeFileSync(join(FIXTURE, '.gitignore'), '.claude/kit/state/\n');
git(FIXTURE, 'add', '.gitignore');
git(FIXTURE, 'commit', '-q', '-m', 'ignore state');
const FIXTURE_HEAD = git(FIXTURE, 'rev-parse', 'HEAD');
process.env.PREDEPLOY_ROOT = FIXTURE;
const STAMP = join(FIXTURE, '.claude', 'kit', 'state', 'predeploy-stamp.json');
function writeStamp(over = {}, raw) {
  mkdirSync(dirname(STAMP), { recursive: true });
  writeFileSync(STAMP, raw ?? JSON.stringify({ sha: FIXTURE_HEAD, at: new Date().toISOString(), ...over }));
}
const clearStamp = () => rmSync(STAMP, { force: true });
const DEPLOY = 'curl -s -X POST "$STUDIO_API_BASE/api/v1/ws/project/deploy" -H "Authorization: Bearer $(cat $STUDIO_API_TOKEN_FILE)"';
const MERGE = 'curl -s -X PUT -H "Authorization: Bearer $TOKEN" https://api.github.com/repos/o/r/pulls/$NUM/merge -d @m.json';

// jobs: repos in each state the rule cares about.
function repo(setup) {
  const dir = makeRepo();
  git(dir, 'branch', 'feat/other');
  if (setup) setup(dir);
  return dir;
}
const MAIN_CLEAN = repo();
const WT = join(tmp('kit-wt-'), 'feat-mine');
git(MAIN_CLEAN, 'worktree', 'add', '-q', '-b', 'feat/mine', WT);
const AT = {
  clean: MAIN_CLEAN,
  dirty: repo((d) => { writeFileSync(join(d, 'a.txt'), 'edited by another session\n'); writeFileSync(join(d, 'new.ts'), 'x\n'); }),
  off: repo((d) => { git(d, 'switch', '-q', '-c', 'feat/left-behind'); writeFileSync(join(d, 'a.txt'), 'half done\n'); }),
  offclean: repo((d) => git(d, 'switch', '-q', 'feat/other')),
  trunk: repo((d) => { git(d, 'branch', '-m', 'main', 'trunk'); mkdirSync(join(d, '.claude')); writeFileSync(join(d, '.claude', 'project-kit.json'), '{"jobs":{"baseBranch":"trunk"}}'); }),
  wt: WT,
  neutral: tmp('kit-neutral-'),
};
const R4 = 'main-dir-stays-on-main';
const R3 = 'deploy-needs-predeploy-stamp';

// [command, expected rule or null, where (default neutral)]
const CASES = [
  // core: no-sweep-staging, blocked
  ['git add -A', 'no-sweep-staging'], ['git add --all', 'no-sweep-staging'], ['git add .', 'no-sweep-staging'],
  ['git add ./', 'no-sweep-staging'], ['git add -u', 'no-sweep-staging'], ['git add --update', 'no-sweep-staging'],
  ['git add -Av', 'no-sweep-staging'], ['git add -- .', 'no-sweep-staging'], ['git add "."', 'no-sweep-staging'],
  ['git add a.ts .', 'no-sweep-staging'], ['git commit -a', 'no-sweep-staging'], ['git commit -am "msg"', 'no-sweep-staging'],
  ['git commit -qam "msg"', 'no-sweep-staging'], ['git commit --all -m x', 'no-sweep-staging'], ['git commit -m x -a', 'no-sweep-staging'],
  ['git -C server commit -a -m x', 'no-sweep-staging'], ['git -c user.name=x add -A', 'no-sweep-staging'],
  ['cd x && git add .', 'no-sweep-staging'], ['npm test; git add -A', 'no-sweep-staging'],
  ['git status | cat || git commit -am x', 'no-sweep-staging'], ['FOO=1 git add -A', 'no-sweep-staging'],
  ['/usr/bin/git add -A', 'no-sweep-staging'], ['echo hi\ngit add -A', 'no-sweep-staging'],
  ['if true; then git add .; fi', 'no-sweep-staging'], ['(cd x && git add -A)', 'no-sweep-staging'],
  ['x=$(git add -A)', 'no-sweep-staging'], ['bash -c "git add -A"', 'no-sweep-staging'],
  ['sh -lc \'cd x && git commit -am y\'', 'no-sweep-staging'], ['eval "git add ."', 'no-sweep-staging'],
  ['bash <<EOF\ngit add -A\nEOF', 'no-sweep-staging'], ['git stage .', 'no-sweep-staging'],
  // core: no-sweep-staging, allowed
  ['git add path/with.dots', null], ['git add ./file', null], ['git add -p', null], ['git add src/a.ts lib/b.ts', null],
  ['git add -f ignored.txt', null], ['git add .gitignore', null], ['git add -N new.ts', null], ['git add -- ./file', null],
  ['git commit -m "message that mentions git add -A"', null], ["git commit -m 'run git commit -am later'", null],
  ['git commit -mupdate', null], ['git commit -m "fix" --amend', null], ['git commit -F msg.txt', null],
  ['git commit --amend --no-edit', null], ['git -C dir commit -m "x"', null], ['echo "git add -A"', null],
  ["echo 'git commit -a' | cat", null], ['git commit -F - <<EOF\ndo not run git add -A or commit -am\nEOF', null],
  ['cat <<\'EOF\' > notes.md\ngit add .\nEOF', null], ['cat <<EOF\n$(echo hello)\ngit add -A\nEOF', null],
  ['grep -rn "git add -A" docs/', null], ['# git add -A\nls', null], ['git log --all --oneline', null],
  ['git stash -u', null], ['ls -a', null], ['', null],
  // core: no-merge-and-delete, blocked
  [`${MERGE} && git branch -d feat/x`, 'no-merge-and-delete'], [`${MERGE}; git branch -D feat/x`, 'no-merge-and-delete'],
  [`${MERGE} && git push origin --delete feat/x`, 'no-merge-and-delete'], [`${MERGE} && git push origin :feat/x`, 'no-merge-and-delete'],
  [`${MERGE} && git push -d origin feat/x`, 'no-merge-and-delete'], [`git branch -d feat/x && ${MERGE}`, 'no-merge-and-delete'],
  ['gh pr merge 5 && git branch -d feat/x', 'no-merge-and-delete'],
  [`${MERGE} && curl -X DELETE https://api.github.com/repos/o/r/git/refs/heads/feat/x`, 'no-merge-and-delete'],
  [`bash -c '${MERGE} && git branch -d x'`.replace(/"/g, '\\"'), 'no-merge-and-delete'],
  // core: no-merge-and-delete, allowed
  [MERGE, null], ['git branch -d feat/x', null], ['git push origin --delete feat/x', null],
  ['gh pr merge 5 --squash --delete-branch', null], [`${MERGE} && git log main --oneline -3`, null],
  ['git push -u origin feat/x', null], ['git branch -m old new', null], ['echo "pulls/1/merge then git branch -d x"', null],
  ['curl -s -X POST https://api.github.com/repos/o/r/pulls -d @pr.json && git branch -d old', null],
  // phoenix: no stamp exists, deploy calls blocked
  [DEPLOY, R3], ['curl -sX POST $STUDIO_API_BASE/api/v1/ws/project/deploy/', R3],
  ['curl -s -X POST "$STUDIO_API_BASE/api/v1/ws/project/deploy?x=1"', R3], [`cd /tmp && ${DEPLOY}`, R3],
  [`bash -c '${DEPLOY}'`.replace(/"/g, '\\"'), R3], ['x=$(curl -s -X POST $STUDIO_API_BASE/api/v1/ws/project/deploy)', R3],
  ["ssh user@host 'curl -s -X POST http://localhost:9/api/v1/ws/project/deploy'", R3],
  ['wget -qO- --post-data= $STUDIO_API_BASE/api/v1/ws/project/deploy', R3],
  // phoenix: the rest of the API is allowed
  ['curl -s -X POST $STUDIO_API_BASE/api/v1/ws/project/deploy/rollback', null],
  ['curl -s $STUDIO_API_BASE/api/v1/ws/project/deployments', null],
  ['curl -s -X POST $STUDIO_API_BASE/api/v1/ws/project/publish -d \'{"gate_enabled":false}\'', null],
  ['curl -s -X POST $STUDIO_API_BASE/api/v1/ws/project/snapshots -d \'{"name":"pre-x"}\'', null],
  ['echo "POST $STUDIO_API_BASE/api/v1/ws/project/deploy"', null], ['git commit -m "gate calls to /project/deploy"', null],
  ['cat <<EOF\ncurl -X POST $STUDIO_API_BASE/api/v1/ws/project/deploy\nEOF', null],
  // jobs: the main checkout stays on its base branch
  ['git switch -c feat/x', R4, 'clean'], ['git checkout -b feat/x', R4, 'clean'], ['git switch feat/other', R4, 'clean'],
  ['git switch --detach HEAD', R4, 'clean'], ['git switch -', R4, 'clean'], ['git checkout -', R4, 'clean'],
  [`git -C ${MAIN_CLEAN} switch -c x`, R4], [`cd ${MAIN_CLEAN} && git checkout -b x`, R4],
  ['git switch main', null, 'clean'], ['git commit -m x', null, 'clean'], ['git pull --ff-only', null, 'clean'],
  ['git stash', null, 'clean'], ['git branch feat/new', null, 'clean'], ['git worktree add ../w -b feat/w', null, 'clean'],
  ['JOB_ALLOW_MAIN_DIR=1 git switch -c hotfix', null, 'clean'], [`cd ${WT} && git switch -c feat/z && git commit -m x`, null, 'clean'],
  ['cd "$W" && git switch -c feat/z', null, 'clean'], ['git switch -c x', null],
  ['git switch -c feat/y', null, 'wt'], ['git reset --hard', null, 'wt'],
  ['git stash', R4, 'dirty'], ['git reset --hard origin/main', R4, 'dirty'], ['git clean -fd', R4, 'dirty'],
  ['git checkout -- a.txt', R4, 'dirty'], ['git restore a.txt', R4, 'dirty'],
  ['git stash list', null, 'dirty'], ['git restore --staged a.txt', null, 'dirty'], ['git add a.txt && git commit -m x', null, 'dirty'],
  ['git commit -m "my work"', R4, 'off'], ['git switch main', R4, 'off'], ['git status && git diff', null, 'off'],
  ['JOB_ALLOW_MAIN_DIR=1 git commit -m x', null, 'off'], ['git switch main', null, 'offclean'], ['git commit -m x', R4, 'offclean'],
  // jobs: the base branch comes from .claude/project-kit.json
  ['git commit -m x', null, 'trunk'], ['git switch -c feat/x', R4, 'trunk'],
];

for (const [command, expected, where = 'neutral'] of CASES) {
  test(`${expected ? 'BLOCK' : 'allow'} [${where}]: ${JSON.stringify(command).slice(0, 90)}`, async () => {
    const hit = await evaluate(command, AT[where], ALL);
    assert.equal(hit ? hit.rule : null, expected, hit ? hit.message : undefined);
  });
}

test('layers: only installed layers run; core always does', async () => {
  assert.equal(await evaluate('git switch -c x', AT.clean, ['core']), null);
  assert.equal(await evaluate(DEPLOY, AT.neutral, ['core', 'jobs']), null);
  assert.equal((await evaluate('git add -A', AT.neutral, ['core']))?.rule, 'no-sweep-staging');
  assert.deepEqual(ruleFiles(['core']).map((f) => f.split('/').slice(-2).join('/')),
    ['core/no-merge-and-delete.mjs', 'core/no-sweep-staging.mjs']);
});

test('jobs: messages name the way out', async () => {
  assert.match((await evaluate('git commit -m x', AT.off, ALL)).message, /feat\/left-behind.*job\.mjs start/s);
  assert.match((await evaluate('git stash', AT.dirty, ALL)).message, /2 uncommitted change\(s\) that are not yours/);
  assert.match((await evaluate('git switch -c x', AT.trunk, ALL)).message, /off `trunk`/);
});

const minAgo = (m) => new Date(Date.now() - m * 60000).toISOString();
async function deployVerdict(setup) {
  clearStamp();
  try { setup(); return await evaluate(DEPLOY, AT.neutral, ALL); } finally { clearStamp(); }
}
test('phoenix: fresh stamp allows; 31 minutes, other commit, malformed or future stamps block', async () => {
  assert.equal(await deployVerdict(() => writeStamp()), null);
  assert.equal(await deployVerdict(() => writeStamp({ at: minAgo(29) })), null);
  assert.match((await deployVerdict(() => writeStamp({ at: minAgo(31) }))).message, /31 min old/);
  assert.match((await deployVerdict(() => writeStamp({ sha: 'deadbeef'.repeat(5) }))).message, /stamp is for deadbeef/);
  assert.equal((await deployVerdict(() => writeStamp({}, '{not json')))?.rule, R3);
  assert.match((await deployVerdict(() => writeStamp({ at: new Date(Date.now() + 3600e3).toISOString() }))).message, /future/);
});
test('phoenix: a stamp does not survive a later edit; the message keeps the owner yes', async () => {
  const stray = join(FIXTURE, 'stray.ts');
  try {
    const hit = await deployVerdict(() => { writeStamp(); writeFileSync(stray, 'x\n'); });
    assert.match(hit.message, /working tree changed after the check/);
    assert.match(hit.message, /predeploy-check\.mjs/);
    assert.match(hit.message, /owner's explicit yes/);
  } finally { rmSync(stray, { force: true }); }
});

test('fail open: a rule whose git call fails is skipped and logged', async () => {
  const saved = process.env.PREDEPLOY_ROOT;
  process.env.PREDEPLOY_ROOT = tmp('kit-norepo-');
  try {
    assert.equal(await evaluate(DEPLOY, AT.neutral, ALL), null);
    const log = readFileSync(join(process.env.PROJECT_KIT_STATE, 'bash-guard-errors.log'), 'utf8');
    assert.match(log, /deploy-needs-predeploy-stamp\.mjs failed/);
  } finally { process.env.PREDEPLOY_ROOT = saved; }
});

function guard(stdin) {
  return spawnSync('node', [GUARD], { input: stdin, encoding: 'utf8', env: { ...process.env, PROJECT_KIT_MODE: 'plugin' } });
}
test('process: a blocked command exits 2 with a one- or two-line reason', () => {
  const r = guard(payload('git add -A', '/tmp'));
  assert.equal(r.status, 2);
  assert.match(r.stderr, /project-kit bash-guard \[no-sweep-staging\].*Stage files by name/);
  assert.ok(r.stderr.split('\n').filter(Boolean).length <= 2);
});
test('process: allowed, non-Bash, bad JSON and empty input all exit 0', () => {
  assert.equal(guard(payload('git add a.ts', '/tmp')).status, 0);
  assert.equal(guard(payload('git add -A', '/tmp', 'Write')).status, 0);
  const bad = guard('not json');
  assert.equal(bad.status, 0);
  assert.ok(existsSync(join(process.env.PROJECT_KIT_STATE, 'bash-guard-errors.log')));
  assert.equal(guard('').status, 0);
});
test('process: fast enough for a PreToolUse hook', () => {
  const t = Date.now();
  guard(payload('git status', '/tmp'));
  assert.ok(Date.now() - t < 1500, `took ${Date.now() - t}ms`);
});
