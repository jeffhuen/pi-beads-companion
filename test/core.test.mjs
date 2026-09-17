import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createCompanion } from "../dist/companion.js";
import { POLICY_MARKER } from "../dist/policy.js";
import omp from "../dist/omp.js";
import pi from "../dist/pi.js";

const ok = value => ({ stdout: typeof value === "string" ? value : JSON.stringify(value), stderr: "", code: 0, killed: false });

async function fixture(t, adopted = true) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pbc-core-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const worlds = new Map();
  async function workspace(name, enabled = true) {
    const cwd = join(root, name);
    const path = join(cwd, ".beads");
    const database_path = join(path, "embeddeddolt");
    await mkdir(database_path, { recursive: true });
    if (enabled) await writeFile(join(path, "PRIME.md"), `${POLICY_MARKER}\nProject policy`);
    worlds.set(cwd, { path, database_path });
    return cwd;
  }
  const cwd = await workspace("first", adopted);
  const state = {
    entries: [], session: "session-a", canWrite: true, before: undefined,
    comments: [], prime: "Project guidance and persistent memory", issue: { id: "pbc-1", title: "Fix the fault", status: "open", comments: [] },
  };
  const ctx = { cwd, sessionManager: { getBranch: () => state.entries, getSessionId: () => state.session } };
  const host = {
    canWrite: () => state.canWrite,
    appendEntry: (customType, data) => state.entries.push({ type: "custom", customType, data }),
    async exec(_command, args, options) {
      const kind = ["where", "prime", "show", "comments"].find(name => args.includes(name));
      const intercepted = await state.before?.(kind, args, options);
      if (intercepted) return intercepted;
      const location = worlds.get(options.cwd);
      if (!location) return { stdout: "", stderr: "no workspace", code: 1, killed: false };
      if (kind === "where") return ok(location);
      if (args[args.indexOf("--db") + 1] !== location.database_path) return { stdout: "", stderr: "wrong database", code: 1, killed: false };
      if (kind === "prime") return ok(state.prime);
      if (kind === "show") {
        const id = args[args.indexOf("show") + 1];
        return id === state.issue.id ? ok([state.issue]) : { stdout: "", stderr: "issue not found", code: 1, killed: false };
      }
      if (kind === "comments") {
        if (args.includes("--readonly")) return { stdout: "", stderr: "read-only", code: 1, killed: false };
        const separator = args.indexOf("--");
        const [issue_id, text] = args.slice(separator + 1);
        if (separator === -1 || !issue_id || text === undefined || args.length !== separator + 3) throw new Error("invalid native comment arguments");
        const comment = { id: `comment-${state.comments.length}`, issue_id, text };
        state.comments.push(comment);
        return ok(comment);
      }
      throw new Error("unsupported native command");
    },
  };
  return { state, ctx, host, worlds, workspace, companion: createCompanion(host) };
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test("unadopted workspaces stay dormant and explicit commands explain adoption", async t => {
  const f = await fixture(t, false);
  assert.equal(await f.companion.context(f.ctx), undefined);
  await assert.rejects(f.companion.command("use pbc-1", f.ctx), /not adopted/);
  assert.deepEqual(f.state.comments, []);
});

test("context bounds native memories and issue text without changing Beads", async t => {
  const f = await fixture(t);
  f.state.prime = "memory ".repeat(20_000);
  f.state.issue.notes = "checkpoint ".repeat(20_000);
  await f.companion.command("use pbc-1", f.ctx);
  const text = await f.companion.context(f.ctx);
  assert.match(text, /untrusted project data/);
  assert.match(text, /pbc-1/);
  assert.match(text, /truncated/);
  assert.ok(text.length < 27_000);
  assert.deepEqual(f.state.comments, []);
});

test("context is cached until invalidation and adopted failures are visible", async t => {
  const f = await fixture(t);
  const first = await f.companion.context(f.ctx);
  f.state.before = () => { throw new Error("bd unavailable"); };
  assert.equal(await f.companion.context(f.ctx), first);
  f.companion.invalidate();
  assert.match(await f.companion.context(f.ctx), /warning:.*unavailable/s);
  await assert.rejects(f.companion.command("status", f.ctx), /available on PATH/);
});

test("killed exit-zero reads and malformed issue JSON cannot select an issue", async t => {
  const f = await fixture(t);
  f.state.before = kind => kind === "show" ? { ...ok([f.state.issue]), killed: true } : undefined;
  await assert.rejects(f.companion.command("use pbc-1", f.ctx), /killed or timed out/);
  f.state.before = kind => kind === "show" ? ok("not JSON") : undefined;
  await assert.rejects(f.companion.command("use pbc-1", f.ctx), /malformed JSON/);
  f.state.before = kind => kind === "show" ? ok([{ ...f.state.issue, id: "pbc-other" }]) : undefined;
  await assert.rejects(f.companion.command("use pbc-1", f.ctx), /invalid output/);
  f.state.before = undefined;
  assert.match(await f.companion.context(f.ctx), /No governing issue selected/);
});

test("selection restores only from the active branch and clear persists a tombstone", async t => {
  const f = await fixture(t);
  await f.companion.command("use pbc-1", f.ctx);
  const selectedBranch = [...f.state.entries];
  const resumed = createCompanion(f.host);
  resumed.restore(f.ctx);
  assert.match(await resumed.context(f.ctx), /pbc-1/);
  await resumed.command("clear", f.ctx);
  const cleared = createCompanion(f.host);
  cleared.restore(f.ctx);
  assert.match(await cleared.context(f.ctx), /No governing issue selected/);
  f.state.entries = selectedBranch;
  cleared.restore(f.ctx);
  assert.match(await cleared.context(f.ctx), /pbc-1/);
  f.state.entries = [];
  cleared.restore(f.ctx);
  assert.match(await cleared.context(f.ctx), /No governing issue selected/);
});

test("selection never follows a different canonical cwd or Beads database", async t => {
  const f = await fixture(t);
  await f.companion.command("use pbc-1", f.ctx);
  const firstCwd = f.ctx.cwd;
  f.ctx.cwd = await f.workspace("second");
  assert.match(await f.companion.context(f.ctx), /No governing issue selected/);
  f.ctx.cwd = firstCwd;
  const alternate = join(f.worlds.get(firstCwd).path, "other-database");
  await mkdir(alternate);
  f.worlds.get(firstCwd).database_path = alternate;
  f.companion.invalidate();
  assert.match(await f.companion.context(f.ctx), /No governing issue selected/);
  await assert.rejects(f.companion.command("checkpoint wrong database", f.ctx), /No governing issue/);
  assert.deepEqual(f.state.comments, []);
});

test("an invalidated in-flight context cannot leak stale selected issue data", async t => {
  const f = await fixture(t);
  await f.companion.command("use pbc-1", f.ctx);
  const started = deferred();
  const finish = deferred();
  f.state.before = async kind => {
    if (kind !== "show") return;
    started.resolve();
    await finish.promise;
    return ok([f.state.issue]);
  };
  const pending = f.companion.context(f.ctx);
  await started.promise;
  await f.companion.command("clear", f.ctx);
  finish.resolve();
  assert.equal(await pending, undefined);
  assert.match(await f.companion.context(f.ctx), /No governing issue selected/);
});

test("an async selection cannot append into a newly active session", async t => {
  const f = await fixture(t);
  const started = deferred();
  const finish = deferred();
  f.state.before = async kind => {
    if (kind !== "show") return;
    started.resolve();
    await finish.promise;
    return ok([f.state.issue]);
  };
  const pending = f.companion.command("use pbc-1", f.ctx);
  await started.promise;
  f.state.session = "session-b";
  f.state.entries = [];
  f.companion.restore(f.ctx);
  finish.resolve();
  await assert.rejects(pending, /session branch changed/);
  assert.match(await f.companion.context(f.ctx), /No governing issue selected/);
});

test("checkpoints preserve multiline text and flag-like text without shell interpretation", async t => {
  const f = await fixture(t);
  await f.companion.command("use pbc-1", f.ctx);
  const text = '--status closed\n"quoted" $(touch /tmp/should-not-run)\n  next step  ';
  await f.companion.command(`checkpoint ${text}`, f.ctx);
  assert.deepEqual(f.state.comments.map(comment => [comment.issue_id, comment.text]), [["pbc-1", text]]);
  await assert.rejects(f.companion.command("use --all", f.ctx), /exact Beads issue ID/);
  await assert.rejects(f.companion.command("checkpoint \n  ", f.ctx), /nonempty/);
  await assert.rejects(f.companion.command(`checkpoint ${"x".repeat(8_001)}`, f.ctx), /at most/);
  assert.equal(f.state.comments.length, 1);
});

test("read-only sessions can select an issue but cannot checkpoint", async t => {
  const f = await fixture(t);
  f.state.canWrite = false;
  await f.companion.command("use pbc-1", f.ctx);
  await assert.rejects(f.companion.command("checkpoint forbidden", f.ctx), /writes are disabled/);
  assert.deepEqual(f.state.comments, []);
  assert.match(await f.companion.context(f.ctx), /pbc-1/);
});

test("checkpoint rechecks native workspace identity immediately before mutation", async t => {
  const f = await fixture(t);
  await f.companion.command("use pbc-1", f.ctx);
  const alternate = join(f.worlds.get(f.ctx.cwd).path, "redirected-database");
  await mkdir(alternate);
  f.state.before = kind => {
    if (kind !== "show") return;
    f.worlds.get(f.ctx.cwd).database_path = alternate;
    return ok([f.state.issue]);
  };
  await assert.rejects(f.companion.command("checkpoint must not follow redirect", f.ctx), /workspace changed/);
  assert.deepEqual(f.state.comments, []);
});

test("write timeout is ambiguous, is never retried, and invalidates context", async t => {
  const f = await fixture(t);
  await f.companion.command("use pbc-1", f.ctx);
  await f.companion.context(f.ctx);
  let attempts = 0;
  f.state.before = kind => {
    if (kind !== "comments") return;
    attempts++;
    f.state.issue.notes = "write may have committed";
    return { ...ok(""), killed: true };
  };
  await assert.rejects(f.companion.command("checkpoint recover here", f.ctx), /inspect issue pbc-1 before retrying/);
  assert.equal(attempts, 1);
  assert.match(await f.companion.context(f.ctx), /write may have committed/);
});

test("a completed write invalidates context loaded during an intervening refresh", async t => {
  const f = await fixture(t);
  await f.companion.command("use pbc-1", f.ctx);
  const started = deferred();
  const finish = deferred();
  f.state.before = async kind => {
    if (kind !== "comments") return;
    started.resolve();
    await finish.promise;
    f.state.issue.notes = "new durable checkpoint";
    return ok({ id: "comment-1", issue_id: "pbc-1", text: "new durable checkpoint" });
  };
  const pending = f.companion.command("checkpoint new durable checkpoint", f.ctx);
  await started.promise;
  f.companion.invalidate();
  assert.doesNotMatch(await f.companion.context(f.ctx), /new durable checkpoint/);
  finish.resolve();
  await pending;
  assert.match(await f.companion.context(f.ctx), /new durable checkpoint/);
});

test("a checkpoint refuses a newly read-only session after asynchronous reads", async t => {
  const f = await fixture(t);
  await f.companion.command("use pbc-1", f.ctx);
  f.state.before = kind => {
    if (kind === "show") f.state.canWrite = false;
  };
  await assert.rejects(f.companion.command("checkpoint forbidden", f.ctx), /writes became disabled/);
  assert.deepEqual(f.state.comments, []);
});

test("bounded recovery context retains the newest checkpoint before old material", async t => {
  const f = await fixture(t);
  f.state.issue.description = "old description ".repeat(1000);
  f.state.issue.acceptance_criteria = "ACCEPTANCE REQUIRED: " + "old acceptance ".repeat(1000);
  f.state.issue.notes = "old notes ".repeat(1000);
  f.state.issue.comments = Array.from({ length: 8 }, (_, i) => ({ text: i === 7 ? "LATEST RECOVERY: next concrete action" : "old checkpoint ".repeat(1000) }));
  await f.companion.command("use pbc-1", f.ctx);
  assert.match(await f.companion.context(f.ctx), /LATEST RECOVERY: next concrete action/);
  assert.match(await f.companion.context(f.ctx), /ACCEPTANCE REQUIRED:/);
});

test("an adopted root warns on first-use discovery failure without activating unadopted roots", async t => {
  for (const adopted of [false, true]) {
    const f = await fixture(t, adopted);
    f.state.before = () => { throw new Error("bd unavailable"); };
    const result = await f.companion.context(f.ctx);
    if (adopted) assert.match(result, /warning:.*unavailable/s);
    else assert.equal(result, undefined);
  }
});

test("native adapters preserve the complete base prompt across repeated turns", async t => {
  for (const adapter of [omp, pi]) {
    const f = await fixture(t);
    const handlers = new Map();
    let command;
    adapter({
      exec: f.host.exec,
      appendEntry: f.host.appendEntry,
      getActiveTools: () => ["bash"],
      registerCommand: (_name, definition) => { command = definition.handler; },
      sendMessage: () => {},
      on: (event, handler) => handlers.set(event, handler),
    });
    handlers.get("session_start")({}, f.ctx);
    await command("use pbc-1", f.ctx);
    for (let turn = 0; turn < 2; turn++) {
      const base = adapter === omp ? ["SYSTEM A", "SYSTEM B"] : "SYSTEM A\nSYSTEM B";
      const result = await handlers.get("before_agent_start")({ systemPrompt: base }, f.ctx);
      if (adapter === omp) {
        assert.deepEqual(result.systemPrompt.slice(0, 2), ["SYSTEM A", "SYSTEM B"]);
        assert.deepEqual(base, ["SYSTEM A", "SYSTEM B"]);
        assert.equal(result.systemPrompt.length, 3);
      } else {
        assert.ok(result.systemPrompt.startsWith(base));
      }
      assert.match(JSON.stringify(result.systemPrompt), /pbc-1/);
    }
  }
});

test("an unowned clone-local prime overrides adoption in a redirected workspace", async t => {
  const f = await fixture(t);
  const owner = f.worlds.get(f.ctx.cwd);
  const clone = await f.workspace("clone", false);
  f.worlds.set(clone, owner);
  f.ctx.cwd = clone;
  await writeFile(join(clone, ".beads", "PRIME.md"), "Custom clone workflow");
  assert.equal(await f.companion.context(f.ctx), undefined);
  await assert.rejects(f.companion.command("use pbc-1", f.ctx), /not adopted/);
  await rm(join(clone, ".beads", "PRIME.md"));
  f.companion.invalidate();
  assert.match(await f.companion.context(f.ctx), /Project guidance/);
});
