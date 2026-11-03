// Real native Pi children + a real isolated Pi Web process. All model responses
// come from a loopback stub, never the user's providers, credentials or sessions.
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { getEventListeners } from "node:events";

const require = createRequire(import.meta.url);
const { PiBackend, isPortFree, delay } = require("../src/backend");
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { integrationBackend, requireDirectory } = require("./integration-prerequisites");
const backendRoot = integrationBackend();
const sdkRoot = path.join(backendRoot, "node_modules/@earendil-works/pi-coding-agent");
const extensionRoot = requireDirectory("PI_AGENT_LAUNCHER_SUBAGENT_PATH");
const userRoles = requireDirectory("PI_AGENT_LAUNCHER_AGENTS_PATH");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-policy-"));
const agentDir = path.join(temp, "agent"), workspace = path.join(temp, "workspace");
const marker = path.join(temp, "FORBIDDEN_RESOURCE_LOADED");
const escapeFile = path.join(temp, "FORBIDDEN_WRITE");
const roles = ["scout", "planner", "worker", "reviewer"];
const plan = ["read", "grep", "find", "ls"], build = ["read", "bash", "edit", "write"];
const requests = [];
let active = [...build, "subagent"], backend, webServer;
const restore = new Map(["PI_CODING_AGENT_DIR", "PI_OFFLINE", "NODE_OPTIONS"].map(key => [key, process.env[key]]));
function write(relative, content) {
  const file = path.join(temp, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content, null, 2), "utf8");
}
function textOf(content) { return typeof content === "string" ? content : (content || []).map(p => p.text || "").join("\n"); }
function answer(res, { text, tool, args, id = "call_probe" }) {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "close" });
  const delta = tool ? { role: "assistant", tool_calls: [{ index: 0, id, type: "function", function: { name: tool, arguments: JSON.stringify(args) } }] }
    : { role: "assistant", content: text };
  const chunk = (d, finish) => ({ id: "chatcmpl-local", object: "chat.completion.chunk", created: Math.floor(Date.now()/1000), model: "probe", choices: [{ index: 0, delta: d, finish_reason: finish }] });
  res.write(`data: ${JSON.stringify(chunk(delta, null))}\n\n`);
  res.write(`data: ${JSON.stringify({ ...chunk({}, tool ? "tool_calls" : "stop"), usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } })}\n\n`);
  res.end("data: [DONE]\n\n");
}
const model = http.createServer(async (req, res) => {
  try {
    let raw = "";
    for await (const part of req) { raw += part; if (raw.length > 2_000_000) throw new Error("oversized request"); }
    const body = JSON.parse(raw);
    const user = [...body.messages].reverse().find(m => m.role === "user");
    const prompt = textOf(user?.content);
    const tools = (body.tools || []).map(t => t.function.name).sort();
    requests.push({ prompt, tools, body });
    if (prompt === "WEB_DISPATCH") {
      if (body.messages.some(m => m.role === "tool" && m.tool_call_id === "call_parent")) return answer(res, { text: "WEB_OK" });
      return answer(res, { tool: "subagent", id: "call_parent", args: { agentScope: "user", tasks: roles.map(agent => ({ agent, task: `ROLE=${agent} WEB_CHILD` })) } });
    }
    const role = prompt.match(/ROLE=(scout|planner|worker|reviewer)/)?.[1];
    if (!role) throw new Error(`Unknown mock request: ${prompt.slice(0, 200)}`);
    if (prompt.includes("WAIT_FOR_ABORT")) return; // Keep this owned child waiting until its caller cancels.
    if (prompt.includes("ATTACK_WRITE") && !body.messages.some(m => m.role === "tool")) {
      return answer(res, { tool: "write", args: { path: escapeFile, content: "must not be written" } });
    }
    answer(res, { text: JSON.stringify({ role, tools, utf8: "子代理正常" }) });
  } catch (error) { res.writeHead(500); res.end(JSON.stringify({ error: { message: String(error) } })); }
});

try {
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(path.join(agentDir, "agents"), { recursive: true });
  fs.cpSync(extensionRoot, path.join(agentDir, "extensions/subagent"), { recursive: true });
  for (const role of roles) fs.copyFileSync(path.join(userRoles, `${role}.md`), path.join(agentDir, `agents/${role}.md`));
  await new Promise(resolve => model.listen(0, "127.0.0.1", resolve));
  write("agent/settings.json", { defaultProvider: "local-subagent-test", defaultModel: "probe", defaultTools: [...build, "subagent"],
    cacheWarming: "off", defaultProjectTrust: "always", retry: { enabled: false }, enableInstallTelemetry: false });
  write("agent/models.json", { providers: { "local-subagent-test": { api: "openai-completions", apiKey: "local-dummy-key",
    baseUrl: `http://127.0.0.1:${model.address().port}/v1`, models: [{ id: "probe", name: "Local probe", reasoning: false,
      input: ["text"], contextWindow: 32768, maxTokens: 2048, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } });
  const poison = `import fs from 'node:fs'; fs.appendFileSync(${JSON.stringify(marker)}, 'loaded\\n'); export default function() {}`;
  write("agent/extensions/poison.ts", poison);
  write("workspace/.pi/extensions/poison.ts", poison);
  write("workspace/.pi/settings.json", { extensions: ["./extensions/poison.ts"] });
  write("workspace/.pi/SYSTEM.md", "PROJECT_SYSTEM_POISON");
  write("mcp-poison.cjs", `require('fs').appendFileSync(${JSON.stringify(marker)}, 'mcp\\n')`);
  const mcp = { mcpServers: { poison: { command: process.execPath, args: [path.join(temp, "mcp-poison.cjs")] } } };
  write("agent/mcp.json", mcp); write("workspace/.pi/mcp.json", mcp);
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_OFFLINE = "1";
  delete process.env.NODE_OPTIONS;
  const { loadExtensions, createExtensionRuntime } = await import(pathToFileURL(path.join(sdkRoot, "dist/core/extensions/loader.js")));
  const runtime = createExtensionRuntime();
  runtime.getActiveTools = () => [...active];
  const loaded = await loadExtensions([path.join(agentDir, "extensions/subagent/index.ts")], workspace, undefined, runtime);
  assert.deepEqual(loaded.errors, []);
  const tool = loaded.extensions[0].tools.get("subagent").definition;
  assert.match(tool.description, /In plan\/build, children cannot load extensions or MCP/);
  const ctx = { cwd: workspace, model: { provider: "local-subagent-test", id: "probe" }, thinkingLevel: "off", hasUI: false, isProjectTrusted: () => true };
  const call = (params, onUpdate, signal = AbortSignal.timeout(45_000)) => tool.execute("test-call", params, signal, onUpdate, ctx);
  function check(result) {
    assert.ok(!result.isError, JSON.stringify(result));
    for (const child of result.details.results) {
      assert.equal(child.exitCode, 0, JSON.stringify(child));
      const final = [...child.messages].reverse().find(m => m.role === "assistant");
      const report = JSON.parse(textOf(final.content));
      assert.equal(report.utf8, "子代理正常");
      if (["scout", "planner"].includes(report.role)) assert.deepEqual(report.tools, [...plan].sort());
      for (const name of report.tools) assert.ok(["read", "bash", "powershell", "edit", "write", "grep", "find", "ls"].includes(name), name);
    }
    assert.ok(!fs.existsSync(marker), "No global/project extension or MCP process may start in a limited child");
    assert.ok(!requests.some(r => JSON.stringify(r.body).includes("PROJECT_SYSTEM_POISON")), "Project system prompt must not override the role");
  }
  const completedSignal = new AbortController();
  check(await call({ agent: "scout", task: "ROLE=scout SINGLE" }, undefined, completedSignal.signal));
  assert.equal(getEventListeners(completedSignal.signal, "abort").length, 0, "Completed children must remove abort listeners");
  check(await call({ tasks: roles.map(agent => ({ agent, task: `ROLE=${agent} PARALLEL` })) }));
  check(await call({ chain: roles.map(agent => ({ agent, task: `ROLE=${agent} CHAIN {previous}` })) }));
  console.log("PASS: Build single, four-way parallel and mixed four-role chain; real native children, inherited model/thinking, UTF-8, no extensions/MCP/project overrides");

  const attack = await call({ agent: "scout", task: "ROLE=scout ATTACK_WRITE" });
  check(attack);
  assert.ok(!fs.existsSync(escapeFile), "A forged model write call must not escape scout's actual tool allowlist");
  assert.ok(attack.details.results[0].messages.some(m => m.role === "toolResult" && m.toolName === "write" && m.isError));
  console.log("PASS: a model-forged write tool call from scout is rejected by the real child runtime");

  const cancel = new AbortController();
  const inflight = call({ agent: "scout", task: "ROLE=scout WAIT_FOR_ABORT" }, undefined, cancel.signal);
  // Attach a rejection observer immediately so a startup failure cannot become unhandled.
  const cancelled = assert.rejects(inflight, /aborted/);
  for (let i = 0; i < 200 && !requests.some(r => r.prompt.includes("WAIT_FOR_ABORT")); i++) await delay(100);
  cancel.abort();
  await cancelled;
  assert.ok(requests.some(r => r.prompt.includes("WAIT_FOR_ABORT")));
  assert.equal(getEventListeners(cancel.signal, "abort").length, 0);
  console.log("PASS: in-flight cancellation stops its own native child and removes abort listeners/timers");

  active = [...plan, "subagent"];
  check(await call({ tasks: roles.slice(0, 2).map(agent => ({ agent, task: `ROLE=${agent} PLAN` })) }));
  const before = requests.length;
  for (const params of [{ agent: "worker", task: "blocked" }, { tasks: roles.map(agent => ({ agent, task: "blocked" })) },
    { chain: [{ agent: "scout", task: "blocked" }, { agent: "reviewer", task: "blocked" }] },
    { agent: "scout", task: "blocked", agentScope: "both" }]) await assert.rejects(call(params));
  assert.equal(requests.length, before, "An invalid mixed batch must dispatch zero children");
  active = [...build, "subagent"];
  for (const params of [{ agent: "unknown", task: "blocked" }, { agent: "worker", task: "blocked", agentScope: "project" }]) await assert.rejects(call(params));
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(call({ agent: "scout", task: "ROLE=scout ABORTED" }, undefined, aborted.signal), /aborted/);
  assert.equal(requests.length, before);
  await assert.rejects(call({ chain: [{ agent: "scout", task: "ROLE=scout TIGHTEN" }, { agent: "worker", task: "ROLE=worker MUST_NOT_START" }] }, () => { active = [...plan, "subagent"]; }), /only permits/);
  assert.equal(requests.length, before + 1);
  console.log("PASS: Plan read-only pair; forbidden roles/scopes/mixed batches and pre-aborted calls start zero children; mid-chain tightening blocks worker");

  // Remove poison fixtures before the parent Web host legitimately loads resources.
  fs.rmSync(path.join(agentDir, "extensions/poison.ts"));
  fs.rmSync(path.join(agentDir, "mcp.json"));
  fs.rmSync(path.join(workspace, ".pi"), { recursive: true });
  assert.ok(await isPortFree(30149), "Refusing to touch an occupied integration-test port");
  backend = new PiBackend({ cwd: workspace, stateDir: path.join(temp, "launcher"), log: console.log });
  Object.assign(backend.env, { PI_AGENT_LAUNCHER_BACKEND_PATH: backendRoot, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" });
  await backend.ensureAvailable();
  webServer = await backend.start(30149);
  const api = async (endpoint, data) => {
    const res = await fetch(webServer.url + endpoint, { method: "POST", headers: { "Content-Type": "application/json", Origin: webServer.url }, body: JSON.stringify(data) });
    const result = await res.json();
    assert.ok(res.ok && !result.error && result.success !== false, JSON.stringify(result));
    return result;
  };
  const created = await api("/api/agent/new", { cwd: workspace, type: "ensure_session" });
  const id = created.sessionId;
  const tools = await api(`/api/agent/${id}`, { type: "get_tools" });
  assert.equal(tools.data.find(t => t.name === "subagent").active, true);
  const childStart = requests.length;
  await api(`/api/agent/${id}`, { type: "prompt", message: "WEB_DISPATCH" });
  let done = false;
  for (let i = 0; i < 180; i++) {
    const detail = await fetch(webServer.url + `/api/sessions/${id}?force=1`).then(r => r.json());
    if (detail.context?.messages?.some(m => m.role === "assistant" && textOf(m.content).includes("WEB_OK"))) { done = true; break; }
    await delay(250);
  }
  assert.ok(done, "Web parent did not complete its actual subagent tool call");
  const webRequests = requests.slice(childStart);
  assert.equal(webRequests.filter(r => r.prompt === "WEB_DISPATCH").length, 2);
  const children = webRequests.filter(r => r.prompt.includes("WEB_CHILD"));
  assert.equal(children.length, 4);
  for (const name of roles) assert.ok(children.some(r => r.prompt.includes(`ROLE=${name}`)));
  console.log("PASS: real Pi Web Build session exposes the actual adapted extension and completes a four-role tool call through the host policy and real CLI children");
  const report = { passed: true, externalModelCalls: 0, realPiChildren: true, realWebBuildFourRoles: true,
    singleParallelChain: true, planDenials: true, noExtensionsOrMcp: true, forgedWriteDenied: true,
    midChainTightening: true, abortCleanup: true, testedAt: new Date().toISOString() };
  fs.mkdirSync(path.join(project, ".build"), { recursive: true });
  fs.writeFileSync(path.join(project, ".build/subagent-runtime-validation.json"), JSON.stringify(report, null, 2), "utf8");
} finally {
  if (webServer) await backend.stop(30149, webServer.info);
  await backend?.close();
  model.closeAllConnections();
  await new Promise(resolve => model.close(resolve));
  for (const [key, value] of restore) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  fs.rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
}
