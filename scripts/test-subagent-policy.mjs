import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

// Optional external integration: the adapted user extension is not shipped here.
const require = createRequire(import.meta.url);
const { requireDirectory } = require("./integration-prerequisites");
const extensionRoot = requireDirectory("PI_AGENT_LAUNCHER_SUBAGENT_PATH");
const { parentToolMode, stricterMode, assertDispatchAllowed, childPolicy } = await import(pathToFileURL(path.join(extensionRoot, "policy.ts")).href);
const plan = ["read", "grep", "find", "ls"];
const build = ["read", "bash", "edit", "write"];
const full = [...build, "grep", "find", "ls"];
const roles = ["scout", "planner", "worker", "reviewer"];
const role = (name, tools = full, source = "user") => ({ name, tools, source });
const task = agent => ({ agent, task: "fixture" });
const requests = names => [...names.map(task), { tasks: names.map(task) }, { chain: names.map(task) }];

test("infer actual tool mode, not TUI/RPC mode; unknown subsets fail closed", () => {
  assert.equal(parentToolMode([...plan, "subagent"]), "plan");
  assert.equal(parentToolMode([...build, "subagent", "webfetch"]), "build");
  assert.equal(parentToolMode(["powershell", "read", "edit", "write"]), "build");
  assert.equal(parentToolMode([...full, "powershell", "codemode"]), "full");
  for (const names of [[], ["read"], ["read", "codemode", "subagent"]]) assert.equal(parentToolMode(names), "restricted");
});
for (const [mode, names] of [["plan", roles.slice(0, 2)], ["build", roles]]) {
  test(`${mode}: permitted roles work in single, parallel and mixed chains`, () => {
    for (const req of requests(names)) assert.ok(assertDispatchAllowed(mode, req).length);
  });
  test(`${mode}: unknown roles and project scopes reject the whole batch`, () => {
    for (const agent of ["unknown", "", null, 1]) {
      for (const req of [task(agent), { tasks: [task("scout"), task(agent)] }, { chain: [task("planner"), task(agent)] }]) {
        assert.throws(() => assertDispatchAllowed(mode, req));
      }
    }
    for (const scope of ["project", "both", "", null, 1]) for (const req of requests(names)) {
      assert.throws(() => assertDispatchAllowed(mode, { ...req, agentScope: scope }), /user-level/);
    }
    for (const req of [{}, { tasks: {} }, { chain: {} }, { tasks: [null] }]) assert.throws(() => assertDispatchAllowed(mode, req));
  });
}
test("Plan rejects worker/reviewer and whole mixed four-role batches", () => {
  for (const req of requests(roles.slice(2)).concat([{ tasks: roles.map(task) }, { chain: roles.map(task) }])) {
    assert.throws(() => assertDispatchAllowed("plan", req), /scout \/ planner/);
  }
});
test("scout/planner cannot inherit shell/write/custom tools in either limited mode", () => {
  for (const mode of ["plan", "build"]) for (const name of roles.slice(0, 2)) {
    const policy = childPolicy(mode, role(name, [...full, "powershell", "subagent", "codemode", "mcp__x", "*", "+write"]));
    assert.deepEqual(policy.tools.sort(), [...plan].sort());
    for (const flag of ["--no-extensions", "--no-mcp", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-approve"]) assert.ok(policy.flags.includes(flag));
  }
});
test("worker/reviewer keep only their declared builtins in Build", () => {
  for (const name of roles.slice(2)) {
    assert.deepEqual(childPolicy("build", role(name, ["read", "bash", "powershell", "subagent", "tool_search", "mcp__x", "*"])).tools, ["read", "bash", "powershell"]);
    assert.throws(() => childPolicy("plan", role(name)));
    assert.throws(() => childPolicy("build", role(name, ["subagent", "mcp__x", "*", "+read"])));
  }
});
test("user role narrowing and empty allowlists never fall back to broad defaults", () => {
  assert.deepEqual(childPolicy("build", role("scout", ["read", "bash"])).tools, ["read"]);
  assert.throws(() => childPolicy("build", role("scout", ["bash"])), /No permitted/);
  assert.throws(() => childPolicy("build", role("scout", [])), /No permitted/);
  assert.throws(() => childPolicy("build", role("scout", plan, "project")), /user-level/);
  assert.deepEqual(childPolicy("build", { name: "scout", source: "user" }).tools, plan);
});
test("Full retains custom roles/scopes and legacy resource behavior", () => {
  assert.deepEqual(assertDispatchAllowed("full", { agent: "custom", agentScope: "project" }), ["custom"]);
  assert.deepEqual(childPolicy("full", role("custom", ["read", "subagent"], "project")), { tools: ["read", "subagent"], flags: [] });
  assert.deepEqual(childPolicy("full", { name: "custom", source: "user" }), { tools: undefined, flags: [] });
});
test("an in-flight dispatch can tighten but never widen its permission ceiling", () => {
  for (const [initial, current, expected] of [["full", "build", "build"], ["build", "full", "build"], ["build", "plan", "plan"], ["plan", "build", "plan"], ["full", "restricted", "restricted"]]) {
    assert.equal(stricterMode(initial, current), expected);
  }
  assert.throws(() => assertDispatchAllowed("restricted", task("scout")), /disabled/);
});
test("returned child policies are independent, not shared mutable arrays", () => {
  const p = childPolicy("build", role("scout")); p.flags.length = 0; p.tools.push("bash");
  assert.ok(childPolicy("build", role("scout")).flags.includes("--no-extensions"));
  assert.ok(!childPolicy("build", role("scout")).tools.includes("bash"));
});
