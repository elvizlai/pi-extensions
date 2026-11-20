import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { isAgyOrchestratorModel } from "./models.ts";
import { PI_TOOLS_AGENT_DESCRIPTION, piToolsAgentPrompt } from "./prompt.ts";

/**
 * Built-in phase-handoff tools required by agy's Orchestrator models
 * (`planexecute.checkPreconditions` disables the two-phase Planner -> Worker
 * pipeline unless both are allowed). Non-orchestrator models have no
 * `execution_model` configured and fail executor construction if either is
 * declared, so standard and Orchestrator models use separate static agents.
 */
export const PI_TOOLS_ORCHESTRATOR_TOOLS = ["enter_plan_mode", "exit_plan_mode"] as const;

export interface PiToolsAgentBridge {
  serverName: string;
  url: string;
  token: string;
}

/**
 * Session-owned custom agents for Pi tool mode, discovered by agy without
 * modifying the workspace. Writes two static variants once per bridge session:
 * standard (`tools: []`) and Orchestrator (`enter_plan_mode`/`exit_plan_mode`).
 */
export function createPiToolsAgent(
  agentRoot = path.join(homedir(), ".gemini", "config", "agents"),
) {
  const baseId = `${process.pid}-${randomUUID()}`;
  const name = `pi-tools-${baseId}`;
  const orchestratorName = `${name}-orchestrator`;
  const directory = path.join(agentRoot, name);
  const orchestratorDirectory = path.join(agentRoot, orchestratorName);
  const directories = [directory, orchestratorDirectory] as const;
  let prepared = false;

  return {
    name,
    orchestratorName,
    directory,
    orchestratorDirectory,
    directories,
    nameForModel: (modelId?: string) => (isAgyOrchestratorModel(modelId) ? orchestratorName : name),
    isPrepared: () => prepared,
    async prepare(bridge: PiToolsAgentBridge): Promise<void> {
      prepared = false;
      const variants = [
        { agentName: name, dir: directory, tools: [] as string[] },
        {
          agentName: orchestratorName,
          dir: orchestratorDirectory,
          tools: [...PI_TOOLS_ORCHESTRATOR_TOOLS],
        },
      ];
      const prompt = piToolsAgentPrompt(bridge.serverName);
      await Promise.all(
        variants.map(async ({ agentName, dir, tools }) => {
          const definition = {
            name: agentName,
            description: PI_TOOLS_AGENT_DESCRIPTION,
            hidden: true,
            mainAgent: true,
            subagent: false,
            inheritCustomizations: false,
            tools,
            mcpServers: [
              {
                name: bridge.serverName,
                serverUrl: bridge.url,
                headers: { "x-pi-bridge-token": bridge.token },
              },
            ],
          };
          await mkdir(dir, { recursive: true, mode: 0o700 });
          // JSON is valid YAML frontmatter and safely quotes the URL, name and token.
          await writeFile(
            path.join(dir, "agent.md"),
            `---
${JSON.stringify(definition, null, 2)}
---

${prompt}
`,
            { mode: 0o600 },
          );
        }),
      );
      prepared = true;
    },
    async remove(): Promise<void> {
      prepared = false;
      await Promise.all(directories.map((dir) => rm(dir, { recursive: true, force: true })));
    },
  };
}
