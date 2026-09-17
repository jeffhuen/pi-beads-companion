import { open, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { POLICY_MARKER } from "./policy.js";

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
  killed: boolean;
}

export type Executor = (command: string, args: string[], options: { cwd: string; timeout: number }) => Promise<ExecResult>;

export interface Workspace {
  cwd: string;
  beadsPath: string;
  databasePath: string;
  adopted: boolean;
}

export interface Issue {
  id: string;
  title: string;
  status: string;
  description?: string;
  acceptance_criteria?: string;
  notes?: string;
  comments?: unknown[];
}

export const MAX_CHECKPOINT_CHARS = 8_000;
const MAX_OUTPUT_CHARS = 1_048_576;

export function bounded(text: string, limit: number): string {
  const suffix = "\n[truncated]";
  return text.length <= limit ? text : text.slice(0, limit - suffix.length) + suffix;
}

export function exactId(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw new Error("Use one exact Beads issue ID, not flags, a search, or a list of IDs.");
  }
  return value;
}

export async function runBd(exec: Executor, cwd: string, args: string[], write = false): Promise<string> {
  let result: ExecResult;
  try {
    // Three sequential context reads must fit OMP's 30-second event-handler limit.
    result = await exec("bd", [...(write ? [] : ["--readonly"]), "--sandbox", ...args], { cwd, timeout: write ? 15_000 : 8_000 });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to run bd; check that it is installed and available on PATH. ${bounded(detail, 500)}`);
  }
  if (!result || typeof result.stdout !== "string" || typeof result.stderr !== "string" ||
      typeof result.killed !== "boolean" || !Number.isInteger(result.code)) {
    throw new Error("bd executor returned invalid process output.");
  }
  if (result.killed) throw new Error("bd was killed or timed out; its result is unavailable.");
  if (result.code !== 0) {
    throw new Error(`bd failed (exit ${result.code}): ${bounded(result.stderr.trim() || result.stdout.trim() || "no diagnostic output", 1_000)}`);
  }
  if (result.stdout.length > MAX_OUTPUT_CHARS) {
    throw new Error("bd returned invalid or oversized output.");
  }
  return result.stdout;
}

function json(text: string): unknown {
  try { return JSON.parse(text); }
  catch { throw new Error("bd returned malformed JSON output."); }
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function hasPolicy(beadsPath: string): Promise<boolean | undefined> {
  let file;
  try {
    file = await open(join(beadsPath, "PRIME.md"), "r");
    const buffer = Buffer.alloc(65_536);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    return buffer.toString("utf8", 0, bytesRead).includes(POLICY_MARKER);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`Cannot read the Beads adoption policy: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await file?.close();
  }
}

export async function resolveWorkspace(exec: Executor, cwd: string): Promise<Workspace> {
  const canonicalCwd = await realpath(resolve(cwd));
  let location: unknown;
  try { location = json(await runBd(exec, canonicalCwd, ["where", "--json"])); }
  catch (error) {
    throw new Error(`Cannot resolve a Beads workspace. Initialize the intended project explicitly with bd init --skip-agents --non-interactive if needed. ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!object(location) || typeof location.path !== "string" || !isAbsolute(location.path) ||
      typeof location.database_path !== "string" || !isAbsolute(location.database_path)) {
    throw new Error("bd where returned invalid workspace output.");
  }
  const beadsPath = await realpath(location.path);
  const databasePath = await realpath(location.database_path);
  // Native bd prime prefers a clone-local override over the resolved workspace.
  // A global template alone does not opt a project into this companion.
  const adopted = await hasPolicy(join(canonicalCwd, ".beads")) ?? await hasPolicy(beadsPath) ?? false;
  return { cwd: canonicalCwd, beadsPath, databasePath, adopted };
}

export function requireAdoption(workspace: Workspace): void {
  if (!workspace.adopted) throw new Error("This project has not adopted pi-beads-companion. Run its setup check and explicitly apply the project policy first.");
}

export function sameWorkspace(a: Workspace, b: Workspace): boolean {
  return a.cwd === b.cwd && a.beadsPath === b.beadsPath && a.databasePath === b.databasePath;
}

export async function readIssue(exec: Executor, workspace: Workspace, id: string): Promise<Issue> {
  exactId(id);
  const output = json(await runBd(exec, workspace.cwd, ["--db", workspace.databasePath, "show", id, "--json", "--include-comments"]));
  const issue = Array.isArray(output) && output.length === 1 ? output[0] : undefined;
  if (!object(issue) || issue.id !== id || typeof issue.title !== "string" || typeof issue.status !== "string" ||
      ["description", "acceptance_criteria", "notes"].some(key => issue[key] != null && typeof issue[key] !== "string") ||
      (issue.comments != null && !Array.isArray(issue.comments))) {
    throw new Error(`bd show returned invalid output for exact issue ${id}.`);
  }
  return issue as unknown as Issue;
}

export async function readPrime(exec: Executor, workspace: Workspace): Promise<string> {
  const prime = await runBd(exec, workspace.cwd, ["--db", workspace.databasePath, "prime", "--full", "--max-memories", "8", "--max-memory-chars", "4000"]);
  if (!prime.trim()) throw new Error("bd prime returned empty output.");
  return bounded(prime, 16_000);
}

export function issueContext(issue: Issue): string {
  const fields = [
    `id: ${JSON.stringify(issue.id)}`,
    `title: ${bounded(JSON.stringify(issue.title), 500)}`,
    `status: ${bounded(JSON.stringify(issue.status), 100)}`,
  ];
  for (const key of ["description", "acceptance_criteria", "notes"] as const) {
    if (issue[key]) fields.push(`${key}: ${bounded(JSON.stringify(issue[key]), 2_000)}`);
  }
  if (issue.comments) {
    const comments = issue.comments.slice(-8).reverse().map(comment => {
      if (!object(comment)) return "[invalid comment omitted]";
      return Object.fromEntries(["author", "text", "created_at"].flatMap(key =>
        typeof comment[key] === "string" ? [[key, bounded(comment[key], key === "text" ? 2_000 : 200)]] : []));
    });
    fields.push(`comments_newest_first: ${bounded(JSON.stringify(comments, null, 2), 3_000)}`);
  }
  return fields.join("\n");
}

export async function addCheckpoint(exec: Executor, workspace: Workspace, id: string, text: string): Promise<void> {
  exactId(id);
  if (!text.trim() || text.length > MAX_CHECKPOINT_CHARS || text.includes("\0")) {
    throw new Error(`Checkpoint text must be nonempty, contain no NUL, and be at most ${MAX_CHECKPOINT_CHARS} characters.`);
  }
  try {
    const result = json(await runBd(exec, workspace.cwd, ["--db", workspace.databasePath, "comments", "add", "--json", "--", id, text], true));
    if (!object(result) || typeof result.id !== "string" || !result.id || result.issue_id !== id || result.text !== text) {
      throw new Error("bd returned invalid checkpoint confirmation.");
    }
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)} The write may have completed; inspect issue ${id} before retrying. No retry was attempted.`);
  }
}
