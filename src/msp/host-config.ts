import { existsSync, lstatSync, mkdirSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, win32 } from "node:path";



const SESSION_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@+_-]{0,511}$/;


export function userMuseConfigDir(options: {
  env?: NodeJS.ProcessEnv;
  homeDirectory?: string;
  platform?: NodeJS.Platform | "win32";
} = {}): string {
  const env = options.env ?? process.env;
  const homeDirectory = options.homeDirectory ?? homedir();
  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    const base = env.LOCALAPPDATA;
    const root = base && win32.isAbsolute(base) ? base : win32.join(homeDirectory, "AppData", "Local");
    return win32.join(root, "muse");
  }
  const dataHome = env.XDG_CONFIG_HOME;
  const root = dataHome && isAbsolute(dataHome) ? dataHome : join(homeDirectory, ".config");
  return join(root, "muse");
}

export interface BridgeSettingsInput {
  systemPrompt: string;
  toolset: string[];
}


export function buildBridgeSettings(input: BridgeSettingsInput): Record<string, unknown> {
  return {
    schema_version: 1,
    run: {
      system_prompt: input.systemPrompt,
      toolset: [...input.toolset],
    },
    context: { foreign_personal_rules: false },
    context_compaction: { soft_threshold: 0.99, hard_threshold: 0.995 },
  };
}


export function writeHostConfig(
  stateDirectory: string,
  sessionKey: string,
  options: { authSourceDir: string; systemPrompt?: string; toolset?: string[] },
): string {
  if (!SESSION_KEY_PATTERN.test(sessionKey)) {
    throw new Error(`Refusing unsafe host config key: ${JSON.stringify(sessionKey)}`);
  }
  const xdg = join(stateDirectory, "hosts", sessionKey);
  const dir = join(xdg, "muse");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const settings = buildBridgeSettings({
    systemPrompt: options.systemPrompt ?? defaultSystemPrompt,
    toolset: options.toolset ?? defaultToolset,
  });
  const settingsPath = join(dir, "settings.json");
  writeFileSync(settingsPath, `${JSON.stringify(settings, null, 1)}\n`, { mode: 0o600 });
  const authSource = join(options.authSourceDir, "auth.json");
  let authPresent = false;
  try {
    authPresent = existsSync(authSource) && lstatSync(authSource).isFile();
  } catch {
    authPresent = false;
  }
  if (authPresent) {
    const link = join(dir, "auth.json");
    try {
      if (lstatSync(link, { throwIfNoEntry: false })?.isSymbolicLink()) rmSync(link, { force: true });
    } catch {
      
    }
    try {
      symlinkSync(authSource, link);
    } catch {
      
    }
  }
  return xdg;
}


export function sweepHostConfigs(
  stateDirectory: string,
  olderThanMs: number,
  now: number = Date.now(),
  keep: ReadonlySet<string> = new Set(),
): string[] {
  const hosts = join(stateDirectory, "hosts");
  let names: string[];
  try {
    names = readdirSync(hosts);
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const name of names) {
    if (!SESSION_KEY_PATTERN.test(name)) continue;
    if (keep.has(name)) continue;
    const path = join(hosts, name);
    let age = 0;
    try {
      const stat = statSync(path);
      if (!stat.isDirectory()) continue;
      age = now - stat.mtimeMs;
    } catch {
      continue;
    }
    if (age < olderThanMs) continue;
    try {
      rmSync(path, { recursive: true, force: true });
      removed.push(name);
    } catch {
      
    }
  }
  return removed;
}

const defaultSystemPrompt = [
  "You are a tool-use engine driven by the host application.",
  "Use ONLY the tools provided by the host over its MCP bridge.",
  "Never use built-in tools, skills, or reminders.",
  "Wait for each tool call to return before continuing the turn.",
].join("\n");


const defaultToolset: string[] = ["mcp__opencode_loopback__*"];
