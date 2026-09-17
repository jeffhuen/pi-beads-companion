#!/usr/bin/env node
import { constants, readFileSync } from "node:fs";
import { access, lstat, open, realpath, rename, unlink } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { AGENTS_BLOCK, POLICY_MARKER } from "./policy.js";

const MAX_BYTES = 1024 * 1024;
// Exact upstream v1.3.0 template bodies, with and without remote-push guidance.
// https://github.com/gastownhall/beads/tree/v1.3.0/internal/templates/agents/defaults
const NATIVE_HASHES: Record<string, string> = {
  "46cd31e7c400d4ca8e14da6339a23f8f5519ba42e86888043b1dcabf3347d1c7": "minimal",
  "1105d64605151672f5a7fcdc662a575b71366599c39bb96461ecf9cfa34578bb": "minimal",
  "94d0f82dcebffd44b0fd146b8d57a6d159b1579ff3c8ee4cb5ae5e766ffa8ce8": "full",
  "ca750cd6c3e383b48280fbc62511bb93e63f697286fcb16d767a489c2d078fd6": "full",
};

type Snapshot = { text: string; mode: number; dev: number; ino: number } | undefined;
type Change = { path: string; before: Snapshot; content: string };
export type SetupResult = {
  cwd: string;
  applied: boolean;
  changes: { path: string; action: "create" | "update"; content: string }[];
  warnings: string[];
};

async function stat(path: string) {
  try { return await lstat(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function safePath(root: string, path: string): Promise<void> {
  const rel = relative(root, path);
  if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) throw new Error(`Path escapes project: ${path}`);
  let current = root;
  for (const part of rel.split(sep).filter(Boolean)) {
    current = join(current, part);
    const info = await stat(current);
    if (!info) return;
    if (info.isSymbolicLink()) throw new Error(`Refusing symlink: ${current}`);
    if (current !== path && !info.isDirectory()) throw new Error(`Not a directory: ${current}`);
  }
}

async function snapshot(root: string, path: string): Promise<Snapshot> {
  await safePath(root, path);
  const info = await stat(path);
  if (!info) return undefined;
  if (!info.isFile() || info.nlink !== 1) throw new Error(`Expected a regular, unlinked file: ${path}`);
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await file.stat();
    if (opened.dev !== info.dev || opened.ino !== info.ino || opened.size > MAX_BYTES) {
      throw new Error(`File changed or exceeds ${MAX_BYTES} bytes: ${path}`);
    }
    const bytes = await file.readFile();
    if (bytes.length > MAX_BYTES) throw new Error(`File exceeds ${MAX_BYTES} bytes: ${path}`);
    return { text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes), mode: info.mode & 0o777, dev: info.dev, ino: info.ino };
  } finally { await file.close(); }
}

function block(text: string, name: string): { start: number; end: number; marker: string; body: string } | undefined {
  const mentions = [...text.matchAll(new RegExp(`(?:BEGIN|END) ${name}`, "gi"))];
  if (mentions.length === 0) return undefined;
  if (mentions.length !== 2) throw new Error(`Malformed or multiple ${name} markers in AGENTS.md; reconcile manually.`);
  const pattern = new RegExp(`^<!-- BEGIN ${name}([^\\r\\n]*?) -->\\r?\\n([\\s\\S]*?)^<!-- END ${name} -->(?=\\r?$)`, "gm");
  const matches = [...text.matchAll(pattern)];
  if (matches.length !== 1) throw new Error(`Malformed or multiple ${name} markers in AGENTS.md; reconcile manually.`);
  const found = matches[0]!;
  return { start: found.index!, end: found.index! + found[0].length, marker: found[1]!, body: found[2]!.replaceAll("\r\n", "\n").replace(/\n$/, "") };
}

function agentsContent(text: string, warnings: string[]): string {
  const own = block(text, "PI-BEADS-COMPANION");
  const native = block(text, "BEADS INTEGRATION");
  if (own && own.marker !== "") throw new Error("Unknown companion marker version in AGENTS.md; reconcile manually.");
  if (own && native && own.start < native.end && native.start < own.end) throw new Error("Nested Beads markers in AGENTS.md; reconcile manually.");
  if (native) {
    const hash = createHash("sha256").update(native.body).digest("hex");
    const fingerprint = createHash("sha256").update(native.body.replace(/\n+$/, "")).digest("hex");
    const profile = NATIVE_HASHES[fingerprint];
    if (!profile || (native.marker !== "" && native.marker !== ` v:1 profile:${profile} hash:${hash.slice(0, 8)}`)) {
      throw new Error("Unknown or modified native BEADS INTEGRATION block in AGENTS.md; reconcile it manually before setup.");
    }
    warnings.push("Replacing the recognized native BEADS INTEGRATION block with companion guidance.");
  }
  const spans = [own, native].filter((value) => value !== undefined).sort((a, b) => b.start - a.start);
  let unrelated = text;
  for (const span of spans) unrelated = unrelated.slice(0, span.start) + unrelated.slice(span.end);
  const plain = unrelated.replace(/[`*_]/g, "");
  if (/(?:\b(?:bd|beads)\b[^\n]{0,240}\b(?:for|tracks?|owns?|manages?|records?)\s+(?:all\s+(?:(?:issue|task)\s+tracking|tasks?|todos?|work)\b|every\s+(?:task|todo)\b))|(?:(?:do not|don't|never|must not)\s+(?:use|create)[^\n]{0,240}(?:TodoWrite|TaskCreate|markdown\s+(?:TODO|task)|native\s+(?:todo|plan)))|pi-beads-extension/i.test(plain)) {
    throw new Error("Potentially conflicting tracking policy outside managed blocks in AGENTS.md; reconcile it manually before setup.");
  }
  if (spans.length === 0) return text + (text.length === 0 ? "" : text.endsWith("\n") ? "\n" : "\n\n") + AGENTS_BLOCK;
  const retained = own ?? native!;
  let result = text;
  for (const span of spans) result = result.slice(0, span.start) + (span === retained ? AGENTS_BLOCK.trimEnd() : "") + result.slice(span.end);
  return result;
}

async function preflight(root: string): Promise<{ changes: Change[]; warnings: string[] }> {
  if (await realpath(root) !== root) throw new Error("Project path changed or contains symlinks; use its canonical path.");
  for (const name of ["BEADS_DIR", "BEADS_DB"]) {
    if (process.env[name]) throw new Error(`Unset ${name} before setup; redirected Beads workspaces are not supported.`);
  }
  await safePath(root, join(root, ".beads"));
  const beads = await stat(join(root, ".beads"));
  if (!beads?.isDirectory()) throw new Error("No initialized local .beads directory. Initialize explicitly with bd init --skip-agents --non-interactive, then retry.");
  if (await stat(join(root, ".beads", "redirect"))) throw new Error("Refusing .beads/redirect; run setup explicitly in the owning checkout.");
  const metadataFile = await snapshot(root, join(root, ".beads", "metadata.json"));
  if (!metadataFile) throw new Error("Missing .beads/metadata.json; initialize or repair Beads explicitly before setup.");
  let metadata: unknown;
  try { metadata = JSON.parse(metadataFile.text); }
  catch { throw new Error("Malformed .beads/metadata.json; repair Beads explicitly before setup."); }
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata) || !("database" in metadata) || typeof metadata.database !== "string" || !metadata.database.trim()) {
    throw new Error("Unrecognized .beads/metadata.json; setup requires initialized Beads metadata.");
  }
  for (const key of ["database", "database_path"]) {
    const value = (metadata as Record<string, unknown>)[key];
    if (value === undefined) continue;
    if (typeof value !== "string" || isAbsolute(value) || value.split(/[\\/]/).includes("..")) throw new Error(`Refusing redirected ${key} in .beads/metadata.json.`);
    await safePath(root, resolve(root, ".beads", value));
  }
  const warnings: string[] = [];
  for (const name of [".pi/settings.json", ".omp/config.yml", ".omp/settings.json", ".omp/settings.yml", ".omp/settings.yaml", "package.json"]) {
    const config = await snapshot(root, join(root, name));
    if (config && /pi-beads-extension/i.test(config.text)) {
      throw new Error(`Legacy pi-beads-extension reference in ${name}. Remove its package/extension/prompt registration manually, reload the host, then retry. Setup does not edit host settings.`);
    }
  }
  const agentsPath = join(root, "AGENTS.md");
  const primePath = join(root, ".beads", "PRIME.md");
  const [agents, prime] = await Promise.all([snapshot(root, agentsPath), snapshot(root, primePath)]);
  if (prime && (!prime.text.replaceAll("\r\n", "\n").startsWith(`${POLICY_MARKER}\n`) || prime.text.split(POLICY_MARKER).length !== 2 || prime.text.split("pi-beads-companion:policy").length !== 2)) {
    throw new Error("Unmanaged or malformed .beads/PRIME.md. Preserve it and reconcile its policy manually; setup will not overwrite it.");
  }
  const primeTemplate = readFileSync(new URL("../PRIME.md", import.meta.url), "utf8").replaceAll("\r\n", "\n");
  if (!primeTemplate.startsWith(`${POLICY_MARKER}\n`) || primeTemplate.split("pi-beads-companion:policy").length !== 2) {
    throw new Error("The packaged PRIME.md must contain exactly one policy v1 marker on its first line.");
  }
  const changes = [
    { path: agentsPath, before: agents, content: agentsContent(agents?.text ?? "", warnings) },
    { path: primePath, before: prime, content: primeTemplate },
  ].filter((change) => change.before?.text !== change.content);
  warnings.push("Only root AGENTS.md and listed local settings are checked. Review inherited/global instructions and copied legacy extensions manually.");
  return { changes, warnings };
}

export async function setup(cwd: string, apply = false): Promise<SetupResult> {
  const root = resolve(cwd);
  const plan = await preflight(root);
  const result: SetupResult = { cwd: root, applied: apply, changes: plan.changes.map((change) => ({ path: relative(root, change.path), action: change.before ? "update" : "create", content: change.content })), warnings: plan.warnings };
  if (!apply || plan.changes.length === 0) return result;
  // Stage every file before replacement. PRIME goes last, so initial adoption is last.
  for (const change of plan.changes) await access(dirname(change.path), constants.W_OK);
  const staged: { change: Change; path: string }[] = [];
  const committed: string[] = [];
  try {
    for (const change of plan.changes) {
      const path = join(dirname(change.path), `.pi-beads-companion-${randomUUID()}.tmp`);
      const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, change.before?.mode ?? 0o644);
      staged.push({ change, path });
      try {
        await file.writeFile(change.content, "utf8");
        await file.chmod(change.before?.mode ?? 0o644);
        await file.sync();
      } finally { await file.close(); }
    }
    const current = await preflight(root);
    if (JSON.stringify(current.changes) !== JSON.stringify(plan.changes)) throw new Error("Project files changed during setup; rerun the dry-run before applying.");
    for (const item of staged) {
      await safePath(root, item.change.path);
      if (await realpath(dirname(item.change.path)) !== dirname(item.change.path)) throw new Error("Project directory changed during setup.");
      await rename(item.path, item.change.path);
      committed.push(relative(root, item.change.path));
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${detail}${committed.length ? ` Replaced: ${committed.join(", ")}. Replacement is atomic per file, not across files; inspect the project before retrying.` : " No project policy files were replaced."}`);
  } finally {
    for (const item of staged) {
      try { await unlink(item.path); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") process.stderr.write(`Could not remove setup temporary file ${item.path}: ${String(error)}\n`); }
    }
  }
  return result;
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { cwd: { type: "string" }, apply: { type: "boolean", default: false }, help: { type: "boolean", short: "h" } }, allowPositionals: false });
  if (values.help) {
    console.log("Usage: node dist/setup.js [--cwd PATH] [--apply]\nDefaults to dry-run. --apply changes only AGENTS.md and .beads/PRIME.md.\nNo initialization, installation, host settings, Git, or remote changes.");
    return;
  }
  const result = await setup(values.cwd ?? process.cwd(), values.apply);
  console.log(`${result.applied ? "Apply" : "Dry-run"}: ${result.cwd}`);
  for (const warning of result.warnings) console.warn(`Warning: ${warning}`);
  for (const change of result.changes) {
    console.log(`${change.action}: ${change.path}`);
    if (!result.applied) console.log(`--- proposed ${change.path} ---\n${change.content}`);
  }
  console.log(result.changes.length === 0 ? "Already configured; no changes." : result.applied ? "Project policy updated." : "No files changed. Review the proposed files, then repeat with --apply.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(await realpath(process.argv[1]).catch(() => resolve(process.argv[1]!))).href) {
  main().catch((error: unknown) => { console.error(`Setup refused: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; });
}
