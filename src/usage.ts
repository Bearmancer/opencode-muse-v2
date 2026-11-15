



import { execFile } from "node:child_process";

export interface UsageMeter {
  percent: number;
  resetsIn: string;
}

export interface MuseUsage {
  window: UsageMeter | null;
  weekly: UsageMeter | null;
}

export interface MeterLine {
  label: string;
  percent: number | null;
  text: string;
}

const METER_LINE = /^\s*(window|weekly)\s*:\s*(\d+)%\s*used\s*,\s*resets in\s*(.+?)\s*$/i;


export function parseMuseUsage(output: string): MuseUsage {
  const usage: MuseUsage = { window: null, weekly: null };
  for (const line of output.split(/\r?\n/)) {
    const match = METER_LINE.exec(line);
    if (!match) continue;
    const percent = Number(match[2]);
    if (!Number.isInteger(percent) || percent < 0 || percent > 100) continue;
    const meter: UsageMeter = { percent, resetsIn: match[3]!.trim() };
    if (match[1]!.toLowerCase() === "window") usage.window = meter;
    else usage.weekly = meter;
  }
  return usage;
}


export function usageBar(percent: number, width = 10): string {
  const filled = Math.round((percent / 100) * width);
  return "█".repeat(filled) + "░".repeat(Math.max(0, width - filled));
}


export function renderMeterLines(usage: MuseUsage): MeterLine[] {
  const line = (label: string, meter: UsageMeter | null): MeterLine => {
    if (meter === null) {
      return { label, percent: null, text: `${label.padEnd(4)} unavailable` };
    }
    return {
      label,
      percent: meter.percent,
      text: `${label.padEnd(4)} ${usageBar(meter.percent)} ${meter.percent}% · ${meter.resetsIn}`,
    };
  };
  return [line("5h", usage.window), line("Week", usage.weekly)];
}


export function museUsageEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next = { ...env };
  delete next.META_API_KEY;
  delete next.MUSE_CONTRIBUTOR_MODE;
  next.MUSE_NO_AUTO_UPDATE = "1";
  return next;
}

export interface ReadMuseUsageOptions {
  museBin?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}


export function readMuseUsage(options: ReadMuseUsageOptions = {}): Promise<MuseUsage> {
  const empty: MuseUsage = { window: null, weekly: null };
  return new Promise((resolve) => {
    try {
      execFile(
        options.museBin ?? "muse",
        ["usage"],
        { env: museUsageEnv(options.env ?? process.env), timeout: options.timeoutMs ?? 15_000, windowsHide: true },
        (error, stdout) => {
          if (error) resolve(empty);
          else resolve(parseMuseUsage(stdout ?? ""));
        },
      );
    } catch {
      resolve(empty);
    }
  });
}
