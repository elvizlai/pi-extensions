import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { normalizeContext, type Context, type Model } from "@earendil-works/pi-ai";

test("switching models while an agy turn is streaming finishes the active step and switches cleanly on the next turn", async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), "agy-model-switch-"));
  const agentDir = path.join(home, "pi-agent");
  const logPath = path.join(home, "agy-invocations.jsonl");
  const agyMjs = path.join(home, "fake-agy.mjs");
  const agyScript = path.join(home, "fake-agy");

  await writeFile(
    agyMjs,
    `import { appendFileSync } from "node:fs";
import readline from "node:readline";

const args = process.argv.slice(2);
if (args.includes("--version")) {
  console.log("agy 1.2.5");
  process.exit(0);
}
if (args[0] === "models") {
  console.log("gemini-pro-orchestrator-neon\\tGemini Pro Orchestrator Neon");
  console.log("gemini-4-carbon\\tGemini 4 Carbon");
  process.exit(0);
}
if (args[0] === "agents") {
  process.exit(0);
}

const modelIdx = args.indexOf("--model");
const model = modelIdx >= 0 ? args[modelIdx + 1] : "unknown";
const convIdx = args.indexOf("--conversation");
const resumedConv = convIdx >= 0 ? args[convIdx + 1] : null;
const convId = resumedConv ?? "conv-" + model + "-" + process.pid;

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", async (line) => {
  const payload = JSON.parse(line);
  const content = payload.message?.content ?? "";
  appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ model, resumedConv, content }) + "\\n");

  console.log(JSON.stringify({ event: "init", conversation_id: convId, init: {} }));

  if (model === "gemini-pro-orchestrator-neon") {
    // Pause slightly so the test can fire model_select mid-stream, matching real TUI timing.
    await new Promise((r) => setTimeout(r, 80));
    console.log(JSON.stringify({
      event: "step_update",
      step_update: {
        conversation_id: convId,
        step_index: 1,
        state: "ACTIVE",
        step_type: "tool",
        tool_name: "view_file",
        tool_info: { name: "view_file", parameters: { AbsolutePath: "/repo/a.ts" } }
      }
    }));
    console.log(JSON.stringify({
      event: "step_update",
      step_update: {
        conversation_id: convId,
        step_index: 1,
        state: "DONE",
        step_type: "tool",
        tool_name: "view_file",
        output: "export const a = 1;",
        tool_info: { name: "view_file", parameters: { AbsolutePath: "/repo/a.ts" } }
      }
    }));
    console.log(JSON.stringify({
      event: "result",
      result: { status: "SUCCESS", response: "inspected", conversation_id: convId, num_turns: 1 }
    }));
    return;
  }

  console.log(JSON.stringify({
    event: "step_update",
    step_update: {
      conversation_id: convId,
      step_index: 1,
      state: "IN_PROGRESS",
      step_type: "agent_response",
      text_delta: "Carbon continued cleanly."
    }
  }));
  console.log(JSON.stringify({
    event: "result",
    result: { status: "SUCCESS", response: "Carbon continued cleanly.", conversation_id: convId, num_turns: 1 }
  }));
});
`,
  );
  await writeFile(
    agyScript,
    `#!/bin/sh\nNODE_OPTIONS= exec ${JSON.stringify(process.execPath)} ${JSON.stringify(agyMjs)} "$@"\n`,
  );
  await chmod(agyScript, 0o755);

  const env: Record<string, string | undefined> = {
    HOME: home,
    USERPROFILE: home,
    HOMEDRIVE: "",
    HOMEPATH: home,
    PI_CODING_AGENT_DIR: agentDir,
    PI_ANTIGRAVITY_PI_TOOL_BRIDGE: "1",
    PI_ANTIGRAVITY_TOOLS: "native",
    PI_ANTIGRAVITY_AGENT: undefined,
    AGY_BINARY: agyScript,
  };
  const previous = new Map(Object.keys(env).map((name) => [name, process.env[name]]));
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  assert.equal(path.resolve(homedir()), path.resolve(home));

  const cache = path.join(agentDir, "antigravity");
  await mkdir(cache, { recursive: true });
  await writeFile(
    path.join(cache, "model-list.json"),
    JSON.stringify({
      fetchedAt: Date.now(),
      source: "live",
      models: [
        { id: "gemini-pro-orchestrator-neon", name: "Neon", supportedEfforts: [] },
        { id: "gemini-4-carbon", name: "Carbon", supportedEfforts: [] },
      ],
    }),
  );

  const handlers = new Map<string, (event: any, ctx: any) => any>();
  let registeredProvider: any;
  const branch: any[] = [];
  let idle = true;
  let neonModel: Model<string> = {
    provider: "antigravity",
    id: "gemini-pro-orchestrator-neon",
    api: "antigravity-stream-json",
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  } as unknown as Model<string>;
  let carbonModel: Model<string> = {
    provider: "antigravity",
    id: "gemini-4-carbon",
    api: "antigravity-stream-json",
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  } as unknown as Model<string>;

  const ctx: any = {
    cwd: home,
    model: neonModel,
    hasUI: true,
    isIdle: () => idle,
    ui: {
      notify: () => {},
      setWidget: () => {},
      setStatus: () => {},
      theme: { fg: (_level: string, text: string) => text },
    },
    sessionManager: { getBranch: () => branch, getSessionId: () => "switch-session" },
  };

  const pi = {
    on: (name: string, handler: (event: any, ctx: any) => any) => handlers.set(name, handler),
    registerCommand: () => {},
    registerFlag: () => {},
    getFlag: () => undefined,
    registerEntryRenderer: () => {},
    registerProvider: (_name: string, config: any) => {
      registeredProvider = config;
    },
    registerTool: () => {},
    getActiveTools: () => ["read", "antigravity"],
    getAllTools: () => [{ name: "read", sourceInfo: { path: "builtin:read" } }],
    getCommands: () => [],
    setActiveTools: () => {},
    appendEntry: (customType: string, data: unknown) =>
      branch.push({ type: "custom", customType, data }),
  };

  t.after(async () => {
    try {
      await handlers.get("session_shutdown")?.({}, ctx);
    } finally {
      for (const [name, value] of previous) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      await rm(home, { recursive: true, force: true });
    }
  });

  const { default: extension } = await import("../index.ts");
  extension(pi as never);
  assert.ok(registeredProvider);
  neonModel =
    registeredProvider.models.find((m: any) => m.id === "gemini-pro-orchestrator-neon") ??
    neonModel;
  carbonModel =
    registeredProvider.models.find((m: any) => m.id === "gemini-4-carbon") ?? carbonModel;
  ctx.model = neonModel;
  await handlers.get("session_start")!({ reason: "new" }, ctx);

  // Start Step 1 on gemini-pro-orchestrator-neon while agent run is active (!idle).
  idle = false;
  await handlers.get("agent_start")?.({}, ctx);

  const step1Context = normalizeContext({
    messages: [
      { role: "user", content: [{ type: "text", text: "Inspect repo and summarize" }] },
    ] as Context["messages"],
  });
  const step1Stream = registeredProvider.streamSimple(neonModel, step1Context);
  const collectStream = async (stream: AsyncIterable<any>) => {
    const out: any[] = [];
    for await (const ev of stream) out.push(ev);
    return out;
  };
  const step1EventsPromise = collectStream(step1Stream);

  // Switch model mid-stream (before fake-agy's 80ms delay completes), just like Ctrl+P in Pi!
  await new Promise((r) => setTimeout(r, 25));
  ctx.model = carbonModel;
  await handlers.get("model_select")!(
    { model: carbonModel, previousModel: neonModel, source: "set" },
    ctx,
  );

  // Step 1 MUST NOT fail with "agy turn was aborted." — it completes its toolUse cleanly!
  const step1Events = await step1EventsPromise;
  const step1Error = step1Events.find((e) => e.type === "error");
  assert.equal(
    step1Error,
    undefined,
    `unexpected error on step 1: ${step1Error?.error?.errorMessage}`,
  );
  const step1Done = step1Events.find((e) => e.type === "done");
  assert.ok(step1Done);
  assert.equal(step1Done.reason, "toolUse");

  // Pi finishes Step 1 tool execution and emits turn_end before starting Step 2 on gemini-4-carbon.
  await handlers.get("turn_end")?.({ message: step1Done.message, toolResults: [] }, ctx);

  const step2Context = normalizeContext({
    messages: [
      { role: "user", content: [{ type: "text", text: "Inspect repo and summarize" }] },
      step1Done.message,
      {
        role: "toolResult",
        toolCallId: step1Done.message.content.find((b: any) => b.type === "toolCall").id,
        toolName: "read",
        content: [{ type: "text", text: "export const a = 1;" }],
        isError: false,
        timestamp: Date.now(),
      },
    ] as Context["messages"],
  });

  const step2Events = await collectStream(
    registeredProvider.streamSimple(carbonModel, step2Context),
  );
  const step2Error = step2Events.find((e) => e.type === "error");
  assert.equal(step2Error, undefined);
  const step2Done = step2Events.find((e) => e.type === "done");
  assert.ok(step2Done);
  assert.equal(step2Done.reason, "stop");
  assert.match(
    step2Done.message.content.map((b: any) => b.text ?? "").join(""),
    /Carbon continued cleanly/,
  );

  idle = true;
  await handlers.get("turn_end")?.({ message: step2Done.message, toolResults: [] }, ctx);
  await handlers.get("agent_settled")?.({ aborted: false }, ctx);

  // Verify fake-agy invocations: Step 1 ran on neon, Step 2 ran on carbon in a fresh conversation
  // carrying Step 1's completed in-turn progress!
  const invocations = (await readFile(logPath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(invocations.length, 2);
  assert.equal(invocations[0].model, "gemini-pro-orchestrator-neon");
  assert.equal(invocations[0].resumedConv, null);
  assert.equal(invocations[1].model, "gemini-4-carbon");
  assert.equal(invocations[1].resumedConv, null);
  assert.match(invocations[1].content, /Inspect repo and summarize/);
  assert.match(invocations[1].content, /tool call: read/);
  assert.match(invocations[1].content, /export const a = 1;/);

  // Also verify transient mid-step cycling (carbon -> other -> carbon) within one active step
  // neither aborts the turn nor resets carbon's established conversation!
  idle = false;
  await handlers.get("agent_start")?.({}, ctx);
  const followUpCtx = normalizeContext({
    messages: [
      ...step2Context.messages,
      step2Done.message,
      { role: "user", content: [{ type: "text", text: "Follow-up on carbon" }] },
    ] as Context["messages"],
  });
  const followUpPromise = collectStream(registeredProvider.streamSimple(carbonModel, followUpCtx));
  const otherModel = {
    provider: "openai",
    id: "gpt-5",
    api: "openai-responses",
  } as unknown as Model<string>;
  ctx.model = otherModel;
  await handlers.get("model_select")!(
    { model: otherModel, previousModel: carbonModel, source: "cycle" },
    ctx,
  );
  ctx.model = carbonModel;
  await handlers.get("model_select")!(
    { model: carbonModel, previousModel: otherModel, source: "cycle" },
    ctx,
  );

  const followUpEvents = await followUpPromise;
  const followUpDone = followUpEvents.find((e) => e.type === "done");
  assert.ok(followUpDone);
  assert.equal(followUpDone.reason, "stop");
  idle = true;
  await handlers.get("turn_end")?.({ message: followUpDone.message, toolResults: [] }, ctx);
  await handlers.get("agent_settled")?.({ aborted: false }, ctx);

  const allInvocations = (await readFile(logPath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(allInvocations.length, 3);
  assert.equal(allInvocations[2].model, "gemini-4-carbon");
  // Same persistent carbon process reused — no unnecessary conversation reset!
  assert.equal(allInvocations[2].content, "Follow-up on carbon");
});
