import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createPiToolsAgent, PI_TOOLS_ORCHESTRATOR_TOOLS } from "../lib/pi-tools-agent.ts";
import { readAgyToolMode, resolveAgyToolModeCommand } from "../lib/tool-mode.ts";

test("tool mode defaults to native and the startup flag overrides the environment", () => {
  assert.equal(readAgyToolMode(undefined, {}), "native");
  assert.equal(readAgyToolMode(undefined, {}, "pi"), "pi");
  assert.equal(readAgyToolMode(undefined, { PI_ANTIGRAVITY_TOOLS: "native" }, "pi"), "native");
  assert.equal(readAgyToolMode("pi", { PI_ANTIGRAVITY_TOOLS: "native" }, "native"), "pi");
  assert.equal(readAgyToolMode(undefined, { PI_ANTIGRAVITY_TOOLS: "pi" }), "pi");
  assert.equal(readAgyToolMode("native", { PI_ANTIGRAVITY_TOOLS: "pi" }), "native");
  assert.equal(readAgyToolMode(" pi ", {}), "pi");
  for (const flag of ["", "unknown", true, 1]) {
    assert.throws(() => readAgyToolMode(flag, {}), /native.*pi/);
  }
});

test("slash command toggles or resolves explicit on/off/status without accepting invalid input", () => {
  assert.equal(resolveAgyToolModeCommand("", "native"), "pi");
  assert.equal(resolveAgyToolModeCommand("  ", "pi"), "native");
  for (const mode of ["native", "pi"] as const) {
    assert.equal(resolveAgyToolModeCommand("on", mode), "pi");
    assert.equal(resolveAgyToolModeCommand(" OFF ", mode), "native");
    assert.equal(resolveAgyToolModeCommand("status", mode), "status");
    assert.equal(resolveAgyToolModeCommand("on off", mode), undefined);
  }
});

test("Pi tool agent prepares standard and orchestrator variants and removes only its own configuration", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "agy-pi-tools-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "existing-agent.md"), "keep");
  const agent = createPiToolsAgent(root);
  const other = createPiToolsAgent(root);
  assert.notEqual(agent.name, other.name);
  assert.notEqual(agent.orchestratorName, agent.name);
  assert.equal(agent.nameForModel("gemini-4-carbon"), agent.name);
  assert.equal(agent.nameForModel(undefined), agent.name);
  assert.equal(agent.nameForModel("gemini-pro-orchestrator"), agent.orchestratorName);
  assert.equal(agent.nameForModel("gemini-pro-orchestrator-neon"), agent.orchestratorName);
  assert.equal(agent.isPrepared(), false);
  const bridge = {
    serverName: "pi-bridge-123",
    url: "http://127.0.0.1:1234/mcp",
    token: "test-token",
  };
  await agent.prepare(bridge);
  assert.equal(agent.isPrepared(), true);

  for (const [agentName, expectedTools] of [
    [agent.name, []],
    [agent.orchestratorName, [...PI_TOOLS_ORCHESTRATOR_TOOLS]],
  ] as const) {
    const agentFile = path.join(root, agentName, "agent.md");
    const definition = JSON.parse((await readFile(agentFile, "utf8")).split("---\n")[1]);
    assert.equal(definition.name, agentName);
    assert.deepEqual(definition.tools, expectedTools);
    assert.equal(definition.hidden, true);
    assert.equal(definition.mainAgent, true);
    assert.equal(definition.inheritCustomizations, false);
    assert.deepEqual(definition.mcpServers, [
      {
        name: bridge.serverName,
        serverUrl: bridge.url,
        headers: { "x-pi-bridge-token": bridge.token },
      },
    ]);
    if (process.platform !== "win32") {
      assert.equal((await stat(agentFile)).mode & 0o777, 0o600);
    }
  }

  await agent.prepare({ ...bridge, url: "http://127.0.0.1:5678/mcp" });
  assert.match(await readFile(path.join(root, agent.name, "agent.md"), "utf8"), /5678/);
  assert.match(await readFile(path.join(root, agent.orchestratorName, "agent.md"), "utf8"), /5678/);
  await agent.remove();
  await agent.remove();
  assert.equal(agent.isPrepared(), false);
  assert.deepEqual(await readdir(root), ["existing-agent.md"]);
});
