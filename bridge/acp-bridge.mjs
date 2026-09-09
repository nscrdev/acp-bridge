#!/usr/bin/env node
// acp-bridge.mjs — generic ACP (Agent Client Protocol) client with a detached
// per-session daemon, so a driver (Claude Code) can start, resume, watch, and
// answer an agent run across many short tool calls.
//
// Harnesses live in harnesses.json (cursor is the verified one). Permission
// policy lives in policy.default.json (+ <workspace>/.acp-bridge/policy.json).
//
// Usage:
//   node acp-bridge.mjs start  [--harness H] [--workspace DIR] [--model ID|alias] [--mode agent|plan|ask]
//                              [--name NAME] [--mcp FILE.json] [--wait] [--timeout SEC] [--idle-exit MIN] -- <prompt>
//   node acp-bridge.mjs send    --name NAME [--wait] [--timeout SEC] [--model ID] [--mode M] -- <prompt>
//   node acp-bridge.mjs status  --name NAME [--json]
//   node acp-bridge.mjs wait    --name NAME [--timeout SEC]
//   node acp-bridge.mjs result  --name NAME
//   node acp-bridge.mjs answer  --name NAME (--permission allow|always|reject | --question QID --option OID[,OID] | --plan accept|reject)
//   node acp-bridge.mjs cancel  --name NAME
//   node acp-bridge.mjs stop    --name NAME
//   node acp-bridge.mjs list
//   node acp-bridge.mjs models  [--harness H] [--workspace DIR]
//
// Exit codes for start/send --wait: 0 turn ended, 3 agent is waiting for an
// answer (permission / question / plan), 4 wait timed out (daemon still runs),
// 1 error.
//
// Store: ~/.claude/tools/acp-bridge/sessions/<name>/{state.json, transcript.jsonl, result.md, inbox/, daemon.log}

import { spawn, execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STORE = path.join(os.homedir(), ".claude", "tools", "acp-bridge", "sessions");
const HARNESSES = JSON.parse(fs.readFileSync(path.join(HERE, "harnesses.json"), "utf8"));
const DEFAULT_POLICY = JSON.parse(fs.readFileSync(path.join(HERE, "policy.default.json"), "utf8"));

// ---------------------------------------------------------------- arg parsing
const argv = process.argv.slice(2);
const cmd = argv.shift();
const opts = {};
let prompt = "";
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--") { prompt = argv.slice(i + 1).join(" "); break; }
  if (a.startsWith("--")) {
    const k = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) opts[k] = true;
    else { opts[k] = next; i++; }
  }
}

const sessDir = (name) => path.join(STORE, name);
const readJSON = (p, fallback = null) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return fallback; } };
// Windows: AV/indexer/other processes hold handles briefly; an unguarded renameSync
// killed a daemon 18 min into a run (EPERM, 2026-09-04). Retry the swap, then fall
// back to an in-place write rather than exit.
// Windows: AV/indexer/other processes hold a handle to state.json for a moment,
// so the atomic tmp->final rename can throw EPERM/EBUSY/EACCES (killed a daemon
// 18 min into a run, 2026-09-04). Try the atomic swap a few times, then fall back
// to an in-place write. Never throw and never busy-wait: the daemon debounces
// writes, so a rare short retry here is cheap, but blocking the event loop while
// a turn streams is not — a couple of quick sync attempts, then in-place.
const writeJSON = (p, v) => {
  const tmp = p + ".tmp";
  const data = JSON.stringify(v, null, 2);
  try {
    fs.writeFileSync(tmp, data);
    for (let i = 0; i < 3; i++) {
      try { fs.renameSync(tmp, p); return true; }
      catch (e) { if (!["EPERM", "EBUSY", "EACCES"].includes(e.code)) throw e; }
    }
    fs.writeFileSync(p, data); try { fs.unlinkSync(tmp); } catch {}
    return true;
  } catch (e) {
    console.error(`acp-bridge: writeJSON failed for ${p}: ${e.code || e.message}`);
    return false;
  }
};
const nowISO = () => new Date().toISOString();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const die = (msg, code = 1) => { console.error(`acp-bridge: ${msg}`); process.exit(code); };
const trunc = (s, n) => (s && s.length > n ? s.slice(0, n) + "…" : s ?? "");

function loadState(name) {
  const st = readJSON(path.join(sessDir(name), "state.json"));
  if (!st) die(`no session named "${name}" (see: list)`);
  return st;
}
// Never throws: a missed checkpoint is recoverable, a dead daemon is not.
function saveState(st) { try { return writeJSON(path.join(sessDir(st.name), "state.json"), st); } catch (e) { console.error(`acp-bridge: saveState failed: ${e.message}`); return false; } }
function pidAlive(pid) { if (!pid) return false; try { process.kill(pid, 0); return true; } catch { return false; } }
function postInbox(name, msg) {
  const inbox = path.join(sessDir(name), "inbox");
  fs.mkdirSync(inbox, { recursive: true });
  const f = path.join(inbox, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`);
  writeJSON(f, { ...msg, ts: nowISO() });
}
function resolveHarness(id) {
  const h = HARNESSES.harnesses[id ?? HARNESSES.default];
  if (!h) die(`unknown harness "${id}". Known: ${Object.keys(HARNESSES.harnesses).join(", ")}`);
  return { id: id ?? HARNESSES.default, ...h };
}
function loadPolicy(workspace) {
  const pol = structuredClone(DEFAULT_POLICY);
  const local = readJSON(path.join(workspace, ".acp-bridge", "policy.json"));
  if (local?.execute) {
    pol.execute.deny.push(...(local.execute.deny ?? []));
    pol.execute.allow.push(...(local.execute.allow ?? []));
  }
  if (local?.parkTimeoutMinutes) pol.parkTimeoutMinutes = local.parkTimeoutMinutes;
  if (local?.parkTimeoutDecision) pol.parkTimeoutDecision = local.parkTimeoutDecision;
  return pol;
}

function spawnDaemon(name) {
  const dir = sessDir(name);
  const log = fs.openSync(path.join(dir, "daemon.log"), "a");
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "_daemon", "--name", name], {
    detached: true, stdio: ["ignore", log, log], windowsHide: true, cwd: dir,
  });
  child.unref();
  return child.pid;
}

// ------------------------------------------------------------ status helpers
function summarize(st) {
  const lastTurn = st.turns[st.turns.length - 1];
  const lines = [];
  lines.push(`${st.name}  harness=${st.harness} model=${st.model ?? "(default)"} mode=${st.mode}  status=${st.status}` +
    (pidAlive(st.pid) ? ` pid=${st.pid}` : " (daemon not running)"));
  lines.push(`workspace=${st.workspace}`);
  lines.push(`agentSession=${st.agentSessionId ?? "-"}  turns=${st.turns.length}  toolCalls=${st.toolCallsTotal}`);
  if (st.pending) {
    lines.push(`WAITING: ${st.pending.kind}  ${trunc(JSON.stringify(st.pending.summary), 400)}`);
    lines.push(`answer with: node acp-bridge.mjs answer --name ${st.name} ` + (
      st.pending.kind === "permission" ? "--permission allow|always|reject" :
      st.pending.kind === "question" ? `--question ${st.pending.summary.questions?.[0]?.id ?? "<id>"} --option <optionId>` :
      "--plan accept|reject"));
  }
  if (st.currentTools?.length) lines.push(`active tools: ${st.currentTools.map(t => `${t.title}[${t.status}]`).join(", ")}`);
  if (st.status === "running" && st.liveText) lines.push(`live: ${trunc(st.liveText.replace(/\s+/g, " "), 300)}`);
  if (lastTurn) lines.push(`last turn: stop=${lastTurn.stopReason} ${lastTurn.durationMs}ms tools=${lastTurn.toolCalls}  text: ${trunc((lastTurn.text ?? "").replace(/\s+/g, " "), 300)}`);
  if (st.error) lines.push(`error: ${st.error}`);
  lines.push(`files: ${path.join(sessDir(st.name), "transcript.jsonl")}  |  result.md`);
  return lines.join("\n");
}

// Wait for a specific prompt (by sendId) to finish, or for the agent to park on
// a question/permission. sendId=null waits for whatever turn is in flight.
async function waitForTurn(name, sendId, timeoutSec) {
  const t0 = Date.now();
  for (;;) {
    const st = loadState(name);
    const done = sendId ? st.turns.find(t => t.sendId === sendId) : null;
    if (done) {
      console.log(done.text ?? "");
      console.error(`\n[acp-bridge] ${name}: stop=${done.stopReason} ${done.durationMs}ms toolCalls=${done.toolCalls} model=${st.model ?? "default"}  (status/result/send --name ${name})`);
      return done.stopReason === "error" ? 1 : 0;
    }
    if (st.pending) { console.log(summarize(st)); return 3; }
    if (!sendId && st.status === "idle") { const last = st.turns[st.turns.length - 1]; console.log(last?.text ?? ""); return 0; }
    if (st.status === "error") { console.log(summarize(st)); return 1; }
    if (st.status === "stopped") { console.log(summarize(st)); return 1; }
    if (!pidAlive(st.pid) && ["running", "starting"].includes(st.status)) { st.status = "error"; st.error = "daemon died (see daemon.log)"; saveState(st); console.log(summarize(st)); return 1; }
    if ((Date.now() - t0) / 1000 > timeoutSec) { console.log(summarize(st)); console.error(`[acp-bridge] wait timed out after ${timeoutSec}s; daemon still running`); return 4; }
    await sleep(700);
  }
}
const newSendId = () => `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

// ------------------------------------------------------------------ commands
async function cmdStart() {
  if (!prompt) die("start needs a prompt after --");
  const harness = resolveHarness(opts.harness);
  const workspace = path.resolve(opts.workspace ?? process.cwd());
  const name = opts.name ?? `${harness.id}-${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 13)}`;
  const dir = sessDir(name);
  if (fs.existsSync(path.join(dir, "state.json"))) die(`session "${name}" exists; use send --name ${name}, or pick another --name`);
  fs.mkdirSync(path.join(dir, "inbox"), { recursive: true });
  let mcpServers = [];
  if (opts.mcp) { mcpServers = readJSON(path.resolve(opts.mcp)); if (!Array.isArray(mcpServers)) die("--mcp file must be a JSON array of ACP mcpServers"); }
  const st = {
    name, harness: harness.id, workspace, mode: opts.mode ?? "agent", model: opts.model ?? null, mcpServers,
    idleExitMinutes: Number(opts["idle-exit"] ?? 30),
    status: "starting", pid: null, agentSessionId: null, created: nowISO(),
    turns: [], toolCallsTotal: 0, currentTools: [], todos: [], pending: null, liveText: "", error: null,
  };
  saveState(st);
  const sendId = newSendId();
  postInbox(name, { type: "send", sendId, text: prompt, model: opts.model ?? null, mode: opts.mode ?? null });
  st.pid = spawnDaemon(name); saveState(st);
  console.error(`[acp-bridge] started ${name} (pid ${st.pid}) harness=${harness.id} model=${st.model ?? "default"} mode=${st.mode} workspace=${workspace}`);
  if (opts.wait) process.exit(await waitForTurn(name, sendId, Number(opts.timeout ?? 900)));
  console.log(name);
}

async function cmdSend() {
  if (!opts.name) die("send needs --name");
  if (!prompt) die("send needs a prompt after --");
  const st = loadState(opts.name);
  if (st.pending) die(`session is waiting for an answer (${st.pending.kind}); use answer first`);
  const sendId = newSendId();
  postInbox(st.name, { type: "send", sendId, text: prompt, model: opts.model ?? null, mode: opts.mode ?? null });
  if (!pidAlive(st.pid)) {
    if (!st.agentSessionId) die("daemon is gone and no agent session id was recorded; start a new session");
    st.status = "starting"; st.pid = spawnDaemon(st.name); saveState(st);
    console.error(`[acp-bridge] daemon respawned (pid ${st.pid}); loading agent session ${st.agentSessionId}`);
  }
  if (opts.wait) process.exit(await waitForTurn(st.name, sendId, Number(opts.timeout ?? 900)));
  console.log(st.name);
}

function cmdStatus() {
  if (!opts.name) die("status needs --name");
  const st = loadState(opts.name);
  if (opts.json) console.log(JSON.stringify(st, null, 2)); else console.log(summarize(st));
  process.exit(st.pending ? 3 : 0);
}

async function cmdWait() {
  if (!opts.name) die("wait needs --name");
  const st = loadState(opts.name);
  if (st.pending) { console.log(summarize(st)); process.exit(3); }
  if (st.status !== "running" && st.status !== "starting") { console.log(summarize(st)); process.exit(0); }
  // A turn is in flight: wait for it (or for the next park).
  process.exit(await waitForTurn(st.name, st.currentSendId ?? null, Number(opts.timeout ?? 900)));
}

function cmdResult() {
  if (!opts.name) die("result needs --name");
  const st = loadState(opts.name);
  const last = st.turns[st.turns.length - 1];
  if (!last) die("no completed turn yet");
  console.log(last.text ?? "");
}

async function cmdAnswer() {
  if (!opts.name) die("answer needs --name");
  const st = loadState(opts.name);
  if (!st.pending) die("nothing is pending");
  if (!pidAlive(st.pid)) die("daemon is not running; the pending request is stale. Use send to continue.");
  let msg;
  if (opts.permission) msg = { type: "answer", kind: "permission", decision: String(opts.permission) };
  else if (opts.question) msg = { type: "answer", kind: "question", questionId: String(opts.question), optionIds: String(opts.option ?? "").split(",").filter(Boolean) };
  else if (opts.plan) msg = { type: "answer", kind: "plan", decision: String(opts.plan) };
  else die("answer needs --permission, --question/--option, or --plan");
  if (msg.kind !== st.pending.kind) die(`pending item is a ${st.pending.kind}, not a ${msg.kind}`);
  postInbox(st.name, msg);
  // Wait until the daemon has consumed the answer so a following `wait` does
  // not see the stale pending item.
  for (let i = 0; i < 20; i++) { await sleep(250); if (!loadState(st.name).pending) break; }
  console.log(`answered ${st.pending.kind}`);
}

function cmdCancel() { if (!opts.name) die("cancel needs --name"); loadState(opts.name); postInbox(opts.name, { type: "cancel" }); console.log("cancel sent"); }

function cmdStop() {
  if (!opts.name) die("stop needs --name");
  const st = loadState(opts.name);
  postInbox(st.name, { type: "stop" });
  setTimeout(() => {
    if (pidAlive(st.pid)) { try { execSync(`taskkill /PID ${st.pid} /T /F`, { stdio: "ignore" }); } catch {} }
    const s2 = loadState(st.name); s2.status = "stopped"; s2.pid = null; s2.pending = null; s2.currentTools = []; s2.liveText = ""; saveState(s2);
    console.log(`stopped ${st.name} (agent session ${st.agentSessionId ?? "-"} kept for send/resume)`);
  }, 1500);
}

// Fork a Cursor desktop/CLI chat (~/.cursor/chats/<ws>/<chatId>/store.db) into a
// new ACP session (~/.cursor/acp-sessions/<newId>/store.db) that the bridge can
// load and continue. The original chat is never touched; this is a snapshot
// fork, not a live link to the desktop UI.
function cmdForkChat() {
  const harness = resolveHarness(opts.harness);
  if (harness.id !== "cursor") die("fork-chat is Cursor-only");
  if (!opts.chat) die("fork-chat needs --chat <chatId>");
  const chatsRoot = path.join(os.homedir(), ".cursor", "chats");
  const hit = fs.readdirSync(chatsRoot).map(ws => path.join(chatsRoot, ws, String(opts.chat))).find(p => fs.existsSync(path.join(p, "store.db")));
  if (!hit) die(`no chat ${opts.chat} under ${chatsRoot}`);
  const meta = readJSON(path.join(hit, "meta.json")) ?? {};
  const workspace = path.resolve(opts.workspace ?? meta.cwd ?? process.cwd());
  const newId = (globalThis.crypto ?? require("node:crypto")).randomUUID();
  const dst = path.join(os.homedir(), ".cursor", "acp-sessions", newId);
  fs.mkdirSync(dst, { recursive: true });
  fs.copyFileSync(path.join(hit, "store.db"), path.join(dst, "store.db"));
  const name = opts.name ?? `fork-${String(opts.chat).slice(0, 8)}`;
  const dir = sessDir(name);
  if (fs.existsSync(path.join(dir, "state.json"))) die(`session "${name}" exists; pick another --name`);
  fs.mkdirSync(path.join(dir, "inbox"), { recursive: true });
  saveState({
    name, harness: "cursor", workspace, mode: opts.mode ?? "ask", model: opts.model ?? null, mcpServers: [],
    idleExitMinutes: Number(opts["idle-exit"] ?? 30), status: "stopped", pid: null, agentSessionId: newId,
    forkedFrom: { chatId: String(opts.chat), path: hit, cwd: meta.cwd ?? null }, created: nowISO(),
    turns: [], toolCallsTotal: 0, currentTools: [], todos: [], pending: null, liveText: "", error: null,
  });
  console.error(`[acp-bridge] forked chat ${opts.chat} -> acp session ${newId} as "${name}" (workspace ${workspace}). Continue with: send --name ${name} -- "<prompt>"`);
  console.log(name);
}

function cmdList() {
  if (!fs.existsSync(STORE)) return console.log("(no sessions)");
  const rows = fs.readdirSync(STORE).map(n => readJSON(path.join(STORE, n, "state.json"))).filter(Boolean)
    .sort((a, b) => (b.created ?? "").localeCompare(a.created ?? ""));
  if (!rows.length) return console.log("(no sessions)");
  for (const st of rows) {
    const alive = pidAlive(st.pid) ? "live" : "off ";
    console.log(`${alive}  ${st.status.padEnd(18)} ${st.name.padEnd(28)} ${(st.model ?? "default").padEnd(22)} turns=${String(st.turns.length).padEnd(3)} ${st.workspace}`);
  }
}

async function cmdModels() {
  const harness = resolveHarness(opts.harness);
  const workspace = path.resolve(opts.workspace ?? process.cwd());
  const conn = await connect(harness, workspace, () => {});
  const s = await conn.send("session/new", { cwd: workspace, mcpServers: [] });
  const modelOpt = (s.configOptions ?? []).find(o => o.id === "model");
  console.log(`harness=${harness.id}  current=${modelOpt?.currentValue ?? s.models?.currentModelId}`);
  for (const m of (modelOpt?.options ?? s.models?.availableModels ?? [])) console.log(`  ${m.value ?? m.modelId}    ${m.name}`);
  console.log(`modes: ${(s.modes?.availableModes ?? []).map(m => m.id).join(", ")}`);
  console.log(`aliases: ${Object.entries(harness.modelAliases ?? {}).map(([k, v]) => `${k}→${v}`).join("  ")}`);
  conn.close();
  process.exit(0);
}

// -------------------------------------------------------------- ACP transport
async function connect(harness, workspace, onMessage) {
  const child = spawn(harness.command, harness.args, { stdio: ["pipe", "pipe", "pipe"], cwd: workspace, windowsHide: true });
  child.stderr.on("data", d => process.stderr.write(`[agent stderr] ${d}`));
  let nextId = 1; const pending = new Map();
  const write = (obj) => child.stdin.write(JSON.stringify(obj) + "\n");
  const send = (method, params) => { const id = nextId++; write({ jsonrpc: "2.0", id, method, params }); return new Promise((res, rej) => pending.set(id, { res, rej, method })); };
  const notify = (method, params) => write({ jsonrpc: "2.0", method, params });
  const respond = (id, result) => write({ jsonrpc: "2.0", id, result });
  const respondError = (id, code, message) => write({ jsonrpc: "2.0", id, error: { code, message } });
  const rl = readline.createInterface({ input: child.stdout });
  rl.on("line", line => {
    let m; try { m = JSON.parse(line); } catch { process.stderr.write(`[agent raw] ${line}\n`); return; }
    if (m.id !== undefined && !m.method) { const w = pending.get(m.id); if (!w) return; pending.delete(m.id); m.error ? w.rej(Object.assign(new Error(m.error.message), { rpc: m.error, method: w.method })) : w.res(m.result ?? {}); return; }
    onMessage(m, { respond, respondError });
  });
  const exited = new Promise(res => child.on("exit", (code, sig) => res({ code, sig })));
  const init = await send("initialize", {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    clientInfo: { name: "acp-bridge", version: "0.1.0" },
  });
  const authIds = (init.authMethods ?? []).map(a => a.id);
  if (harness.authMethod && authIds.includes(harness.authMethod)) await send("authenticate", { methodId: harness.authMethod });
  // The launcher is cmd.exe -> powershell -> node; kill the whole tree or the
  // grandchild keeps the stdio pipes open and the caller never exits.
  const killTree = () => { try { if (process.platform === "win32") execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: "ignore" }); else child.kill("SIGTERM"); } catch {} };
  // Cursor persists session/set_model into the user's CLI config as the new
  // interactive default (observed 2026-09-03). Snapshot it and put it back.
  const cfgPath = harness.cliConfig ? path.resolve(harness.cliConfig.replace(/^~/, os.homedir())) : null;
  const cfgSnapshot = cfgPath ? readJSON(cfgPath) : null;
  const restoreCliDefault = () => {
    if (!cfgSnapshot?.model) return;
    const cur = readJSON(cfgPath); if (!cur?.model) return;
    if (JSON.stringify(cur.model) !== JSON.stringify(cfgSnapshot.model)) {
      cur.model = cfgSnapshot.model;
      if ("modelParameters" in cfgSnapshot) cur.modelParameters = cfgSnapshot.modelParameters;
      try { fs.writeFileSync(cfgPath, JSON.stringify(cur, null, 2)); process.stderr.write(`[acp-bridge] restored CLI default model ${cfgSnapshot.model.modelId}\n`); } catch {}
    }
  };
  // Kill the tree first: once stdin closes, cmd.exe exits before its
  // powershell/node children do, and taskkill /T cannot follow a dead parent.
  const close = () => { killTree(); try { child.stdin.end(); } catch {} restoreCliDefault(); };
  process.on("exit", () => { killTree(); restoreCliDefault(); });
  return { child, send, notify, respond, init, exited, close };
}

function resolveModelId(harness, configOptions, wanted) {
  if (!wanted) return null;
  const modelOpt = (configOptions ?? []).find(o => o.id === "model");
  const options = modelOpt?.options ?? [];
  const aliased = harness.modelAliases?.[wanted] ?? wanted;
  const exact = options.find(o => o.value === aliased);
  if (exact) return exact.value;
  const byPrefix = options.find(o => o.value.startsWith(aliased + "[") || o.value === aliased);
  if (byPrefix) return byPrefix.value;
  const byName = options.find(o => o.name.toLowerCase().includes(aliased.toLowerCase()));
  if (byName) return byName.value;
  // Allow a raw variant string like "grok-4.6[effort=low,fast=true]" through unchanged.
  return aliased;
}

// -------------------------------------------------------------------- daemon
async function daemon() {
  const name = opts.name; if (!name) die("_daemon needs --name");
  const dir = sessDir(name);
  let st = loadState(name);
  const harness = resolveHarness(st.harness);
  const policy = loadPolicy(st.workspace);
  const transcript = fs.createWriteStream(path.join(dir, "transcript.jsonl"), { flags: "a" });
  const log = (o) => transcript.write(JSON.stringify({ ts: nowISO(), ...o }) + "\n");
  // State persistence: the hot path (per-chunk tool_call updates) debounces so we
  // write at most every 250 ms instead of 50-150 times a turn; that shrinks the
  // file-lock window an order of magnitude. Real transitions (status changes,
  // turn boundaries, exit) flush immediately so `status`/`wait` see them at once.
  let saveTimer = null, saveDirty = false;
  const flushSave = () => { saveDirty = false; if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; } saveState(st); };
  const save = () => { saveDirty = true; if (!saveTimer) saveTimer = setTimeout(() => { saveTimer = null; if (saveDirty) flushSave(); }, 250); };
  const setStatus = (s) => { st.status = s; flushSave(); };
  console.log(`[${nowISO()}] daemon up pid=${process.pid} session=${name}`);

  let replaying = false;
  let turn = null;                 // { text, toolCalls, t0, prompt }
  let pendingResolver = null;      // (answerMsg) => void
  let pendingTimer = null;
  const tools = new Map();

  function park(kind, summary, onAnswer, onTimeout) {
    st.pending = { kind, summary, since: nowISO() }; setStatus(`waiting_${kind}`);
    pendingResolver = (ans) => { clearTimeout(pendingTimer); pendingTimer = null; pendingResolver = null; st.pending = null; setStatus("running"); onAnswer(ans); };
    pendingTimer = setTimeout(() => { if (pendingResolver) { const r = pendingResolver; pendingResolver = null; st.pending = null; setStatus("running"); log({ event: "park_timeout", kind }); onTimeout(); } }, policy.parkTimeoutMinutes * 60_000);
  }

  function onMessage(m, ctx) { try { return onMessageInner(m, ctx); } catch (e) { console.error(`acp-bridge: onMessage error (non-fatal): ${e.message}`); log({ event: "onmessage_error", error: e.message }); } }
  function onMessageInner(m, { respond }) {
    log({ dir: "in", msg: m });
    if (m.method === "session/update") {
      const u = m.params?.update ?? {};
      if (replaying) return;
      switch (u.sessionUpdate) {
        case "agent_message_chunk": if (turn && u.content?.type === "text") { turn.text += u.content.text; st.liveText = turn.text.slice(-600); } break;
        case "tool_call": tools.set(u.toolCallId, { title: u.title, kind: u.kind, status: u.status }); if (turn) turn.toolCalls++; st.toolCallsTotal++; st.currentTools = [...tools.values()].filter(t => t.status !== "completed" && t.status !== "failed").slice(-6); save(); break;
        case "tool_call_update": { const t = tools.get(u.toolCallId); if (t) t.status = u.status ?? t.status; st.currentTools = [...tools.values()].filter(t => t.status !== "completed" && t.status !== "failed").slice(-6); save(); break; }
        case "current_mode_update": st.mode = u.currentModeId; save(); break;
        case "session_info_update": st.title = u.title; save(); break;
        default: break;
      }
      return;
    }
    if (m.method === "session/request_permission") {
      const tc = m.params?.toolCall ?? {};
      const options = m.params?.options ?? [];
      const pick = (kind) => options.find(o => o.kind === kind)?.optionId ?? options.find(o => o.optionId?.includes(kind.split("_")[0]))?.optionId;
      const decide = (kind) => { const optionId = pick(kind); log({ event: "permission", decision: kind, tool: tc.title }); respond(m.id, { outcome: { outcome: "selected", optionId } }); };
      const command = tc.rawInput?.command ?? (tc.title ?? "").replace(/^`|`$/g, "");
      if (tc.kind === "execute") {
        if (policy.execute.deny.some(r => new RegExp(r, "i").test(command))) return decide("reject_once");
        if (policy.execute.allow.some(r => new RegExp(r, "i").test(command))) return decide("allow_once");
        return park("permission", { tool: tc.title, kind: tc.kind, command, note: tc.content?.[0]?.content?.text }, (ans) => {
          const d = ans.decision === "always" ? "allow_always" : ans.decision === "allow" ? "allow_once" : "reject_once"; decide(d);
        }, () => decide(policy.parkTimeoutDecision === "allow" ? "allow_once" : "reject_once"));
      }
      return decide(policy.nonExecute.allow ? "allow_once" : "reject_once");
    }
    if (m.method === "cursor/ask_question") {
      return park("question", { title: m.params?.title, questions: m.params?.questions }, (ans) => {
        respond(m.id, { outcome: { outcome: "answered", answers: [{ questionId: ans.questionId, selectedOptionIds: ans.optionIds }] } });
      }, () => respond(m.id, { outcome: { outcome: "skipped", reason: "no answer within park timeout" } }));
    }
    if (m.method === "cursor/create_plan") {
      st.plan = { name: m.params?.name, overview: m.params?.overview, plan: m.params?.plan, todos: m.params?.todos }; save();
      return park("plan", { name: m.params?.name, overview: m.params?.overview, todos: (m.params?.todos ?? []).map(t => t.content) }, (ans) => {
        respond(m.id, { outcome: ans.decision === "accept" ? { outcome: "accepted" } : { outcome: "rejected", reason: "rejected by driver" } });
      }, () => respond(m.id, { outcome: { outcome: "rejected", reason: "no answer within park timeout" } }));
    }
    if (m.method === "cursor/update_todos") {
      st.todos = m.params?.merge ? mergeTodos(st.todos, m.params.todos ?? []) : (m.params?.todos ?? []); save();
      if (m.id !== undefined) respond(m.id, { outcome: { outcome: "accepted", todos: st.todos } });
      return;
    }
    if (m.method === "cursor/task" || m.method === "cursor/generate_image") {
      if (m.id !== undefined) respond(m.id, { outcome: { outcome: "rejected", reason: "not supported by acp-bridge" } });
      return;
    }
    if (m.id !== undefined) respond(m.id, { outcome: { outcome: "skipped", reason: `unhandled method ${m.method}` } });
  }
  const mergeTodos = (old, upd) => { const map = new Map(old.map(t => [t.id, t])); for (const t of upd) map.set(t.id, t); return [...map.values()]; };

  let conn;
  try {
    conn = await connect(harness, st.workspace, onMessage);
    conn.exited.then(({ code }) => { if (st.status !== "stopped") { st.status = "error"; st.error = `agent process exited (code ${code})`; st.pid = null; flushSave(); } console.log(`[${nowISO()}] agent exited ${code}`); process.exit(0); });
    let sess;
    if (st.agentSessionId && conn.init.agentCapabilities?.loadSession) {
      replaying = true;
      try {
        sess = await conn.send("session/load", { sessionId: st.agentSessionId, cwd: st.workspace, mcpServers: st.mcpServers ?? [] });
        log({ event: "session_loaded", sessionId: st.agentSessionId });
      } catch (e) {
        // Some harnesses advertise loadSession but fail on it (codex-acp). Start fresh and say so.
        log({ event: "session_load_failed", sessionId: st.agentSessionId, error: e.message });
        (st.warnings = st.warnings ?? []).push(`session/load ${st.agentSessionId} failed (${e.message}); started a fresh agent session, prior context lost`);
        sess = await conn.send("session/new", { cwd: st.workspace, mcpServers: st.mcpServers ?? [] });
        st.agentSessionId = sess.sessionId;
      }
      replaying = false;
    } else {
      sess = await conn.send("session/new", { cwd: st.workspace, mcpServers: st.mcpServers ?? [] });
      st.agentSessionId = sess.sessionId;
    }
    st.configOptions = sess.configOptions ?? null; flushSave();
    setStatus("idle");
  } catch (e) {
    st.status = "error"; st.error = `connect failed: ${e.message}`; st.pid = null; save(); console.error(e); process.exit(1);
  }

  // Mode/model selection is best-effort: some harnesses (codex-acp) reject
  // session/set_model or have no modes. Record a warning and keep the turn.
  async function applySelection(model, mode) {
    st.warnings = st.warnings ?? [];
    if (mode && mode !== st.mode) {
      try { await conn.send("session/set_mode", { sessionId: st.agentSessionId, modeId: mode }); st.mode = mode; }
      catch (e) { st.warnings.push(`set_mode(${mode}) failed: ${e.message}`); log({ event: "set_mode_failed", mode, error: e.message }); }
    }
    if (model) {
      const id = resolveModelId(harness, st.configOptions, model);
      const current = (st.configOptions ?? []).find(o => o.id === "model")?.currentValue;
      if (id !== st.modelResolved && id !== current) {
        // Cursor implements session/set_model; Devin only implements the generic
        // session/set_config_option (configId "model"). Try both before giving up.
        let ok = false, lastErr = null;
        for (const attempt of [
          () => conn.send("session/set_model", { sessionId: st.agentSessionId, modelId: id }),
          () => conn.send("session/set_config_option", { sessionId: st.agentSessionId, configId: "model", value: id }),
        ]) {
          try { const r = await attempt(); ok = true; if (Array.isArray(r?.configOptions)) st.configOptions = r.configOptions; break; } catch (e) { lastErr = e; }
        }
        if (ok) {
          st.modelResolved = id; st.model = id; log({ event: "model_set", model: id });
          // Trust but verify: an adapter can ack set_config_option yet not switch
          // (observed with a fusion id on Devin, 2026-09-04 - status showed the
          // default and no warning fired). If the echoed config disagrees, say so.
          const applied = (st.configOptions ?? []).find(o => o.id === "model")?.currentValue;
          if (applied && applied !== id) { st.warnings.push(`requested model '${id}' but the agent reports '${applied}'; it may not offer that id`); st.model = applied; log({ event: "model_not_applied", requested: id, applied }); }
        }
        else { st.warnings.push(`model select (${id}) failed: ${lastErr?.message}; using ${current ?? "harness default"}`); st.model = current ?? st.model; log({ event: "set_model_failed", model: id, error: lastErr?.message }); }
      } else { st.modelResolved = id; st.model = id; }
    }
    save();
  }

  async function runPrompt(msg) {
    turn = { text: "", toolCalls: 0, t0: Date.now(), prompt: msg.text };
    st.liveText = ""; st.currentTools = []; st.currentSendId = msg.sendId ?? null; tools.clear(); setStatus("running");
    try {
      await applySelection(msg.model ?? (st.turns.length === 0 ? st.model : null), msg.mode);
      const r = await conn.send("session/prompt", { sessionId: st.agentSessionId, prompt: [{ type: "text", text: msg.text }] });
      const rec = { sendId: msg.sendId ?? null, prompt: msg.text, text: turn.text, stopReason: r.stopReason, durationMs: Date.now() - turn.t0, toolCalls: turn.toolCalls, ended: nowISO() };
      st.turns.push(rec);
      fs.writeFileSync(path.join(dir, "result.md"), `# ${name} — turn ${st.turns.length}\n\nprompt: ${msg.text}\n\nstop: ${r.stopReason}  ${rec.durationMs}ms  toolCalls=${rec.toolCalls}\n\n---\n\n${turn.text}\n`);
    } catch (e) {
      st.turns.push({ sendId: msg.sendId ?? null, prompt: msg.text, text: turn.text, stopReason: "error", error: e.message, durationMs: Date.now() - turn.t0, toolCalls: turn.toolCalls, ended: nowISO() });
      st.error = e.message;
    }
    turn = null; st.liveText = ""; st.currentTools = []; st.currentSendId = null; setStatus("idle");
  }

  const inbox = path.join(dir, "inbox");
  const queue = [];
  let busy = false;
  let idleSince = Date.now();
  // Startup drain: only "send" messages survive a daemon restart. A stale
  // "stop" or "answer" from a previous daemon must not act on this one.
  for (const f of fs.readdirSync(inbox).filter(f => f.endsWith(".json")).sort()) {
    const p = path.join(inbox, f); const msg = readJSON(p);
    if (msg?.type !== "send") { fs.unlinkSync(p); log({ event: "stale_inbox_dropped", msg }); }
  }
  for (;;) {
    for (const f of fs.readdirSync(inbox).filter(f => f.endsWith(".json")).sort()) {
      const p = path.join(inbox, f); const msg = readJSON(p); fs.unlinkSync(p); if (!msg) continue;
      log({ dir: "inbox", msg });
      if (msg.type === "stop") { st.pid = null; st.currentTools = []; st.liveText = ""; setStatus("stopped"); conn.close(); await sleep(300); process.exit(0); }
      if (msg.type === "cancel") { if (busy) conn.notify("session/cancel", { sessionId: st.agentSessionId }); continue; }
      if (msg.type === "answer") { if (pendingResolver) pendingResolver(msg); else log({ event: "answer_ignored" }); continue; }
      if (msg.type === "send") queue.push(msg);
    }
    // Run the turn without blocking this loop, so answers/cancel/stop still
    // arrive while the agent is working.
    if (!busy && queue.length) { busy = true; const msg = queue.shift(); runPrompt(msg).finally(() => { busy = false; idleSince = Date.now(); }); }
    if (!busy && !queue.length && (Date.now() - idleSince) > st.idleExitMinutes * 60_000) {
      console.log(`[${nowISO()}] idle ${st.idleExitMinutes}min, exiting; agent session ${st.agentSessionId} kept`);
      st.pid = null; setStatus("stopped"); conn.close(); await sleep(300); process.exit(0);
    }
    await sleep(400);
  }
}

// ---------------------------------------------------------------------- main
const commands = { start: cmdStart, send: cmdSend, "fork-chat": cmdForkChat, status: cmdStatus, wait: cmdWait, result: cmdResult, answer: cmdAnswer, cancel: cmdCancel, stop: cmdStop, list: cmdList, models: cmdModels, _daemon: daemon };
if (!commands[cmd]) die(`usage: acp-bridge.mjs <${Object.keys(commands).filter(c => !c.startsWith("_")).join("|")}> ...`, 2);
await commands[cmd]();
