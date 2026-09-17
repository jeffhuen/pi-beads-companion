import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, link, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { setup } from '../dist/setup.js';
import { AGENTS_BLOCK, BLOCK_END, BLOCK_START } from '../dist/policy.js';

const run = promisify(execFile);
const cli = fileURLToPath(new URL('../dist/setup.js', import.meta.url));
const PRIME = (await readFile(new URL('../PRIME.md', import.meta.url), 'utf8')).replaceAll('\r\n', '\n');

async function project(t) {
  const root = await mkdtemp(join(tmpdir(), 'pbc-setup-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, '.beads'));
  await writeFile(join(root, '.beads/metadata.json'), JSON.stringify({ database: 'dolt', backend: 'dolt' }));
  return root;
}

test('adversarial policy text completes without unbounded regex work', async (t) => {
  const root = await project(t);
  await writeFile(join(root, 'AGENTS.md'), (BLOCK_START + '\n').repeat(Math.floor(900_000 / (BLOCK_START.length + 1))));
  await assert.rejects(run(process.execPath, [cli, '--cwd', root], { timeout: 5000 }), /markers/);
  await writeFile(join(root, 'AGENTS.md'), 'bd '.repeat(300_000));
  const preview = await run(process.execPath, [cli, '--cwd', root], { timeout: 5000, maxBuffer: 4 * 1024 * 1024 });
  assert.match(preview.stdout, /Dry-run/);
  await assert.rejects(stat(join(root, '.beads/PRIME.md')), { code: 'ENOENT' });
});

test('CLI defaults to a read-only preview and requires --apply', async (t) => {
  const root = await project(t);
  const original = '# Existing rules\r\n\r\nBeads records durable outcomes, not every todo transition.\r\n';
  await writeFile(join(root, 'AGENTS.md'), original);
  const before = await readdir(join(root, '.beads'));
  const preview = await run(process.execPath, [cli, '--cwd', root]);
  assert.match(preview.stdout, /Dry-run/);
  assert.equal(await readFile(join(root, 'AGENTS.md'), 'utf8'), original);
  assert.deepEqual(await readdir(join(root, '.beads')), before);
  await run(process.execPath, [cli, '--cwd', root, '--apply']);
  assert.equal(await readFile(join(root, '.beads/PRIME.md'), 'utf8'), PRIME);
  assert.ok((await readFile(join(root, 'AGENTS.md'), 'utf8')).startsWith(original));
  const agentsBefore = await stat(join(root, 'AGENTS.md'));
  const primeBefore = await stat(join(root, '.beads/PRIME.md'));
  assert.deepEqual((await setup(root, true)).changes, []);
  assert.equal((await stat(join(root, 'AGENTS.md'))).ino, agentsBefore.ino);
  assert.equal((await stat(join(root, '.beads/PRIME.md'))).ino, primeBefore.ino);
  await assert.rejects(run(process.execPath, [cli, '--apply', '--unknown']), /Unknown option/);
});

test('managed replacement preserves unrelated bytes and existing permissions', async (t) => {
  const root = await project(t);
  const prefix = '\ufeff# Team policy\r\n\r\n';
  const suffix = '\r\n\r\n## Unrelated\r\nKeep this.\r\n';
  await writeFile(join(root, 'AGENTS.md'), `${prefix}${BLOCK_START}\r\nold policy\r\n${BLOCK_END}${suffix}`);
  await writeFile(join(root, '.beads/PRIME.md'), PRIME.replaceAll('\n', '\r\n'));
  await chmod(join(root, 'AGENTS.md'), 0o640);
  await setup(root, true);
  assert.equal(await readFile(join(root, 'AGENTS.md'), 'utf8'), prefix + AGENTS_BLOCK.trimEnd() + suffix);
  assert.equal((await stat(join(root, 'AGENTS.md'))).mode & 0o777, 0o640);
  assert.equal(await readFile(join(root, '.beads/PRIME.md'), 'utf8'), PRIME);
});

test('unmanaged PRIME and invalid second targets cause no policy writes', async (t) => {
  const root = await project(t);
  await writeFile(join(root, 'AGENTS.md'), 'Keep me.\n');
  await writeFile(join(root, '.beads/PRIME.md'), 'Custom workflow\n');
  await assert.rejects(setup(root, true), /Unmanaged/);
  assert.equal(await readFile(join(root, 'AGENTS.md'), 'utf8'), 'Keep me.\n');
  assert.equal(await readFile(join(root, '.beads/PRIME.md'), 'utf8'), 'Custom workflow\n');
  await rm(join(root, '.beads/PRIME.md'));
  await mkdir(join(root, '.beads/PRIME.md'));
  await assert.rejects(setup(root, true), /regular/);
  assert.equal(await readFile(join(root, 'AGENTS.md'), 'utf8'), 'Keep me.\n');
});

test('malformed, duplicated, nested, and unknown tracking blocks are refused', async (t) => {
  const cases = [
    BLOCK_START + '\nmissing end\n',
    AGENTS_BLOCK + AGENTS_BLOCK,
    `${BLOCK_END}\n${BLOCK_START}\n`,
    '<!-- BEGIN BEADS INTEGRATION -->\ncustom instructions\n<!-- END BEADS INTEGRATION -->\n',
    `${BLOCK_START}\n<!-- BEGIN BEADS INTEGRATION -->\ncustom\n<!-- END BEADS INTEGRATION -->\n${BLOCK_END}\n`,
    'Use **bd** for ALL task tracking.\n',
    'Do NOT use TodoWrite or TaskCreate.\n',
  ];
  for (const content of cases) {
    const root = await project(t);
    await writeFile(join(root, 'AGENTS.md'), content);
    await assert.rejects(setup(root, true), /markers|block|tracking policy/i);
    assert.equal(await readFile(join(root, 'AGENTS.md'), 'utf8'), content);
    await assert.rejects(stat(join(root, '.beads/PRIME.md')), { code: 'ENOENT' });
  }
});

test('redirects and symlink or hardlink targets never change the other checkout', async (t) => {
  const outside = await project(t);
  await writeFile(join(outside, 'protected'), 'Do not change.\n');
  for (const target of ['AGENTS.md', '.beads/PRIME.md', '.beads']) {
    const root = await project(t);
    if (target === '.beads') await rm(join(root, '.beads'), { recursive: true });
    await symlink(target === '.beads' ? join(outside, '.beads') : join(outside, 'protected'), join(root, target));
    await assert.rejects(setup(root, true), /symlink/);
  }
  const root = await project(t);
  await link(join(outside, 'protected'), join(root, 'AGENTS.md'));
  await assert.rejects(setup(root, true), /regular/);
  await rm(join(root, 'AGENTS.md'));
  await writeFile(join(root, '.beads/redirect'), join(outside, '.beads'));
  await assert.rejects(setup(root, true), /redirect/);
  await rm(join(root, '.beads/redirect'));
  await writeFile(join(root, '.beads/metadata.json'), JSON.stringify({ database: '../../other.db' }));
  await assert.rejects(setup(root, true), /redirect/);
  assert.equal(await readFile(join(outside, 'protected'), 'utf8'), 'Do not change.\n');
  await assert.rejects(stat(join(outside, '.beads/PRIME.md')), { code: 'ENOENT' });
});

test('local legacy registration blocks adoption without editing host settings', async (t) => {
  for (const name of ['.pi/settings.json', '.omp/settings.json', '.omp/config.yml']) {
    const root = await project(t);
    await mkdir(join(root, name.split('/')[0]));
    const content = 'packages: [npm:pi-beads-extension]\n';
    await writeFile(join(root, name), content);
    await assert.rejects(setup(root, true), /Remove.*manually/);
    assert.equal(await readFile(join(root, name), 'utf8'), content);
    await assert.rejects(stat(join(root, 'AGENTS.md')), { code: 'ENOENT' });
    await assert.rejects(stat(join(root, '.beads/PRIME.md')), { code: 'ENOENT' });
  }
});

test('setup requires initialized metadata and refuses oversized or invalid UTF-8 instructions', async (t) => {
  const root = await project(t);
  await rm(join(root, '.beads/metadata.json'));
  await assert.rejects(setup(root, true), /metadata/);
  await writeFile(join(root, '.beads/metadata.json'), JSON.stringify({ database: 'dolt' }));
  await writeFile(join(root, 'AGENTS.md'), Buffer.alloc(1024 * 1024 + 1, 65));
  await assert.rejects(setup(root, true), /exceeds/);
  await writeFile(join(root, 'AGENTS.md'), Buffer.from([0xff, 0xfe]));
  await assert.rejects(setup(root, true));
  assert.deepEqual(await readFile(join(root, 'AGENTS.md')), Buffer.from([0xff, 0xfe]));
  await assert.rejects(stat(join(root, '.beads/PRIME.md')), { code: 'ENOENT' });
});

// Exact upstream v1.3.0 minimal template. A modified body must not be removed.
const nativeMinimal = "## Beads Issue Tracker\n\nThis project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.\n\n### Quick Reference\n\n```bash\nbd ready              # Find available work\nbd show <id>          # View issue details\nbd update <id> --claim  # Claim work\nbd close <id>         # Complete work\n```\n\n### Rules\n\n- Use `bd` for ALL task tracking \u2014 do NOT use TodoWrite, TaskCreate, or markdown TODO lists\n- Run `bd prime` for detailed command reference and session close protocol\n- Use `bd remember` for persistent knowledge \u2014 do NOT use MEMORY.md files\n\n**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git remote; `.beads/issues.jsonl` is a passive export. See https://github.com/gastownhall/beads/blob/main/docs/core-concepts/sync-concepts.md for details and anti-patterns.\n\n## Agent Context Profiles\n\nThe managed Beads block is task-tracking guidance, not permission to override repository, user, or orchestrator instructions.\n\n- **Conservative (default)**: Use `bd` for task tracking. Do not run git commits, git pushes, or Dolt remote sync unless explicitly asked. At handoff, report changed files, validation, and suggested next commands.\n- **Minimal**: Keep tool instruction files as pointers to `bd prime`; use the same conservative git policy unless active instructions say otherwise.\n- **Team-maintainer**: Only when the repository explicitly opts in, agents may close beads, run quality gates, commit, and push as part of session close. A current \"do not commit\" or \"do not push\" instruction still wins.\n\n## Session Completion\n\nThis protocol applies when ending a Beads implementation workflow. It is subordinate to explicit user, repository, and orchestrator instructions.\n\n1. **File issues for remaining work** - Create beads for anything that needs follow-up\n2. **Run quality gates** (if code changed) - Tests, linters, builds\n3. **Update issue status** - Close finished work, update in-progress items\n4. **Handle git/sync by active profile**:\n   ```bash\n   # Conservative/minimal/default: report status and proposed commands; wait for approval.\n   git status\n\n   # Team-maintainer opt-in only, unless current instructions forbid it:\n   git pull --rebase\n   bd dolt push\n   git push\n   git status\n   ```\n5. **Hand off** - Summarize changes, validation, issue status, and any blocked sync/commit/push step\n\n**Critical rules:**\n- Explicit user or orchestrator instructions override this Beads block.\n- Do not commit or push without clear authority from the active profile or the current user request.\n- If a required sync or push is blocked, stop and report the exact command and error.";

test('recognized native blocks migrate, but a modified body does not', async (t) => {
  for (const noPush of [false, true]) {
    const root = await project(t);
    const body = noPush ? nativeMinimal.replace('\n   bd dolt push\n', '\n') : nativeMinimal;
    const hash = createHash('sha256').update(body).digest('hex').slice(0, 8);
    const source = `# Before\r\n<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:${hash} -->\n${body}\n<!-- END BEADS INTEGRATION -->\r\n# After\r\n`;
    await writeFile(join(root, 'AGENTS.md'), source);
    await setup(root, true);
    assert.equal(await readFile(join(root, 'AGENTS.md'), 'utf8'), '# Before\r\n' + AGENTS_BLOCK.trimEnd() + '\r\n# After\r\n');
    await writeFile(join(root, 'AGENTS.md'), source.replace('### Rules', '### Custom rules'));
    await assert.rejects(setup(root, true), /Unknown or modified native/);
    assert.equal(await readFile(join(root, 'AGENTS.md'), 'utf8'), source.replace('### Rules', '### Custom rules'));
  }
});
