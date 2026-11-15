import { spawnSync } from "node:child_process";
import { MuseInvalidConfigError } from "../errors.js";


export type ContributorMode = "on" | "off";


export const CONTRIBUTOR_MODE_OPTION = "contributorMode";


export const CONTRIBUTOR_MODE_ENV = "OPENCODE_MUSE_CONTRIBUTOR_MODE";


export function resolveContributorMode(raw: unknown): ContributorMode {
  if (raw === undefined) return "on";
  if (raw === true) return "on";
  if (raw === false) return "off";
  if (typeof raw === "string") {
    const wanted = raw.trim().toLowerCase();
    if (wanted === "on") return "on";
    if (wanted === "off") return "off";
  }
  throw new MuseInvalidConfigError(
    `Invalid Contributor mode ${JSON.stringify(raw) ?? "?"}: set ${CONTRIBUTOR_MODE_OPTION} to true/false (or ${CONTRIBUTOR_MODE_ENV} to on/off), or leave it unset for the default (on).`,
  );
}


export function contributorServeArgs(mode: ContributorMode): [string, ContributorMode] {
  return ["--contributor-mode", mode];
}


const STRIPPED_CHILD_ENV_KEYS = new Set(["META_API_KEY", "MUSE_CONTRIBUTOR_MODE"]);


export function museChildEnv(source: Record<string, string | undefined> = process.env): Record<string, string> {
  const cleaned: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (STRIPPED_CHILD_ENV_KEYS.has(key.toUpperCase())) continue;
    cleaned[key] = value;
  }
  cleaned.MUSE_NO_AUTO_UPDATE = "1";
  return cleaned;
}


export function baseServeArgs(providerId: string, mode: ContributorMode): string[] {
  return ["serve", "--provider", providerId, ...contributorServeArgs(mode)];
}

export interface ServeHelpResult {
  stdout: string;
}

export type ServeHelpRunner = (museBin: string) => ServeHelpResult | Promise<ServeHelpResult>;

function defaultServeHelpRunner(museBin: string): ServeHelpResult {
  const result = spawnSync(museBin, ["serve", "--help"], { encoding: "utf8", timeout: 15_000, env: museChildEnv(process.env) });
  return { stdout: typeof result.stdout === "string" ? result.stdout : "" };
}


export async function assertContributorFlagSupported(
  museBin: string,
  runHelp: ServeHelpRunner = defaultServeHelpRunner,
): Promise<void> {
  let stdout = "";
  try {
    stdout = (await runHelp(museBin)).stdout;
  } catch {
    throw new MuseInvalidConfigError(
      `Cannot confirm ${museBin} supports --contributor-mode ("serve --help" did not run); refusing to bill without proof of the requested lane.`,
    );
  }
  if (!stdout.includes("--contributor-mode")) {
    throw new MuseInvalidConfigError(
      `${museBin} does not advertise --contributor-mode; refusing to bill without proof of the requested lane.`,
    );
  }
}


export function paygBillingNotice(env: Record<string, string | undefined> | undefined = process.env): string | undefined {
  if (env?.META_API_KEY === undefined) return undefined;
  return "opencode-muse is subscription-only and META_API_KEY is set: for pay-as-you-go billing use OpenCode's official OpenAI-compatible provider (metamate) instead of this plugin.";
}
