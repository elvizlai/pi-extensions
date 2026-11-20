import { randomUUID } from "node:crypto";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { piConfigDir } from "./config.ts";
import { agyMcpCacheDir } from "./mcp-cache.ts";

const BRIDGE_DIR_PATTERN =
  /^(\d+)-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const PI_TOOLS_AGENT_PATTERN = /^pi-tools-(\d+)-[0-9a-f-]+(?:-orchestrator)?$/i;

function defaultIsPidDead(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === "ESRCH";
  }
}

/**
 * Best-effort cleanup of bridge configs, pi-tools agents, and MCP descriptor
 * caches left behind by terminated Pi processes (e.g. SIGKILL / hard crashes).
 */
export async function sweepDeadBridgeArtifacts(options?: {
  bridgesRoot?: string;
  agentsRoot?: string;
  mcpCacheRoot?: string;
  isPidDead?: (pid: number) => boolean;
}): Promise<void> {
  const bridgesRoot = options?.bridgesRoot ?? piConfigDir("antigravity/bridges");
  const agentsRoot = options?.agentsRoot ?? path.join(homedir(), ".gemini", "config", "agents");
  const mcpCacheRoot = options?.mcpCacheRoot ?? agyMcpCacheDir();
  const isPidDead = options?.isPidDead ?? defaultIsPidDead;

  try {
    const entries = await readdir(bridgesRoot);
    await Promise.all(
      entries.map(async (entry) => {
        const match = BRIDGE_DIR_PATTERN.exec(entry);
        if (!match || !isPidDead(Number(match[1]))) return;
        const serverName = `pi-${match[2].replaceAll("-", "").slice(0, 12)}`;
        await Promise.allSettled([
          rm(path.join(bridgesRoot, entry), { recursive: true, force: true }),
          rm(path.join(mcpCacheRoot, serverName), { recursive: true, force: true }),
        ]);
      }),
    );
  } catch {
    // Missing or unreadable bridges directory is non-fatal.
  }

  try {
    const entries = await readdir(agentsRoot);
    await Promise.all(
      entries.map(async (entry) => {
        const match = PI_TOOLS_AGENT_PATTERN.exec(entry);
        if (!match || !isPidDead(Number(match[1]))) return;
        await rm(path.join(agentsRoot, entry), { recursive: true, force: true }).catch(() => {});
      }),
    );
  } catch {
    // Missing or unreadable agents directory is non-fatal.
  }
}

/** One process's workspace MCP discovery, passed only to its agy children. */
export function createPrivateMcpConfig(root = piConfigDir("antigravity/bridges")) {
  const id = randomUUID();
  // agy caches descriptors by server name; keep that key unique and short.
  const serverName = `pi-${id.replaceAll("-", "").slice(0, 12)}`;
  const directory = path.join(root, `${process.pid}-${id}`);
  const agentsDirectory = path.join(directory, ".agents");

  return {
    serverName,
    directory,
    async write(url: string, token: string): Promise<void> {
      await mkdir(agentsDirectory, { recursive: true, mode: 0o700 });
      await writeFile(
        path.join(agentsDirectory, "mcp_config.json"),
        `${JSON.stringify(
          {
            mcpServers: {
              [serverName]: {
                serverUrl: url,
                headers: { "x-pi-bridge-token": token },
              },
            },
          },
          null,
          2,
        )}\n`,
        { mode: 0o600 },
      );
    },
    async remove(): Promise<void> {
      await rm(directory, { recursive: true, force: true });
    },
  };
}
