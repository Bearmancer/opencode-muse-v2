import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

describe("headless child processes", () => {
  test("headless.everyChildProcessCallHidesItsWindow", () => {
    const callPattern = /\b(?:spawnSync|execFileSync|execSync|execFile|spawn)\(/g;
    const offenders: string[] = [];
    for (const file of sourceFiles(join(import.meta.dir, "..", "..", "src"))) {
      const text = readFileSync(file, "utf8");
      if (!text.includes("node:child_process")) continue;
      const calls = (text.match(callPattern) ?? []).length;
      const hidden = (text.match(/windowsHide:\s*true/g) ?? []).length;
      if (hidden < calls) offenders.push(`${file}: ${calls} calls, ${hidden} windowsHide`);
    }
    expect(offenders).toEqual([]);
  });
});
