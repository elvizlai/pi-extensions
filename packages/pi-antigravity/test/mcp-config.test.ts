import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createPrivateMcpConfig, sweepDeadBridgeArtifacts } from "../lib/mcp-config.ts";

// The actual private workspace format is consumed by both native and Pi agy agents.
test("private MCP configurations isolate credentials and clean up only their own directory", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "agy-private-mcp-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const a = createPrivateMcpConfig(root);
  const b = createPrivateMcpConfig(root);
  assert.notEqual(a.directory, b.directory);
  assert.notEqual(a.serverName, b.serverName);
  assert.ok(a.serverName.length <= 16);
  assert.deepEqual(await readdir(root), [], "constructing an extension starts no resources");
  await writeFile(path.join(root, "foreign.json"), "keep");
  await a.write("http://127.0.0.1:1234/mcp", "token-a");
  await b.write("http://127.0.0.1:5678/mcp", "token-b");
  const configFile = (directory: string) => path.join(directory, ".agents", "mcp_config.json");
  assert.deepEqual(JSON.parse(await readFile(configFile(a.directory), "utf8")), {
    mcpServers: {
      [a.serverName]: {
        serverUrl: "http://127.0.0.1:1234/mcp",
        headers: { "x-pi-bridge-token": "token-a" },
      },
    },
  });
  assert.equal((await readFile(configFile(b.directory), "utf8")).includes("token-a"), false);
  if (process.platform !== "win32") {
    assert.equal((await stat(a.directory)).mode & 0o777, 0o700);
    assert.equal((await stat(path.dirname(configFile(a.directory)))).mode & 0o777, 0o700);
    assert.equal((await stat(configFile(a.directory))).mode & 0o777, 0o600);
  }
  await a.remove();
  await a.remove();
  assert.equal(await readFile(path.join(root, "foreign.json"), "utf8"), "keep");
  assert.equal((await readFile(configFile(b.directory), "utf8")).includes("token-b"), true);
  await a.write("http://127.0.0.1:9012/mcp", "new-token");
  assert.equal((await readFile(configFile(a.directory), "utf8")).includes("new-token"), true);
  await a.remove();
  await b.remove();
  assert.deepEqual(await readdir(root), ["foreign.json"]);
});

test("failed private configuration writes can remove a partially created directory", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "agy-private-mcp-fail-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = createPrivateMcpConfig(root);
  await mkdir(config.directory, { recursive: true });
  await writeFile(path.join(config.directory, ".agents"), "not a directory");
  await assert.rejects(config.write("http://127.0.0.1:1234/mcp", "token"));
  await config.remove();
  assert.deepEqual(await readdir(root), []);
});

test("sweepDeadBridgeArtifacts removes dead-PID bridge, agent, and mcp cache artifacts while preserving live and foreign ones", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "agy-sweep-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bridgesRoot = path.join(root, "bridges");
  const agentsRoot = path.join(root, "agents");
  const mcpCacheRoot = path.join(root, "mcp");
  await Promise.all([
    mkdir(bridgesRoot, { recursive: true }),
    mkdir(agentsRoot, { recursive: true }),
    mkdir(mcpCacheRoot, { recursive: true }),
  ]);

  const deadUuid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  const liveUuid = "11111111-2222-3333-4444-555555555555";
  const deadBridge = `999999-${deadUuid}`;
  const liveBridge = `888888-${liveUuid}`;
  const deadCache = "pi-aaaaaaaabbbb";
  const liveCache = "pi-111111112222";
  const deadAgent = `pi-tools-999999-${deadUuid}`;
  const deadOrchAgent = `pi-tools-999999-${deadUuid}-orchestrator`;
  const liveAgent = `pi-tools-888888-${liveUuid}`;
  const liveOrchAgent = `pi-tools-888888-${liveUuid}-orchestrator`;

  await Promise.all([
    mkdir(path.join(bridgesRoot, deadBridge)),
    mkdir(path.join(bridgesRoot, liveBridge)),
    mkdir(path.join(bridgesRoot, "legacy-foreign")),
    mkdir(path.join(mcpCacheRoot, deadCache)),
    mkdir(path.join(mcpCacheRoot, liveCache)),
    mkdir(path.join(mcpCacheRoot, "other-server")),
    mkdir(path.join(agentsRoot, deadAgent)),
    mkdir(path.join(agentsRoot, deadOrchAgent)),
    mkdir(path.join(agentsRoot, liveAgent)),
    mkdir(path.join(agentsRoot, liveOrchAgent)),
    mkdir(path.join(agentsRoot, "custom-agent")),
  ]);

  await sweepDeadBridgeArtifacts({
    bridgesRoot,
    agentsRoot,
    mcpCacheRoot,
    isPidDead: (pid) => pid === 999999,
  });

  assert.deepEqual((await readdir(bridgesRoot)).sort(), ["legacy-foreign", liveBridge].sort());
  assert.deepEqual((await readdir(mcpCacheRoot)).sort(), ["other-server", liveCache].sort());
  assert.deepEqual(
    (await readdir(agentsRoot)).sort(),
    ["custom-agent", liveAgent, liveOrchAgent].sort(),
  );
});
