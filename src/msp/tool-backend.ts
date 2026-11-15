import { MuseInvalidConfigError } from "../errors.js";


export type ToolBackend = "muse" | "opencode";


export const TOOL_BACKEND_OPTION = "toolBackend";


export const TOOL_BACKEND_ENV = "OPENCODE_MUSE_TOOL_BACKEND";


export function resolveToolBackend(raw: unknown): ToolBackend {
  if (raw === undefined) return "muse";
  if (typeof raw !== "string") {
    throw new MuseInvalidConfigError(
      `Invalid tool backend: set ${TOOL_BACKEND_OPTION} to "muse"/"opencode" (or ${TOOL_BACKEND_ENV} to muse/opencode), or leave it unset for the default ("muse").`,
    );
  }
  const wanted = raw.trim().toLowerCase();
  if (wanted === "muse") return "muse";
  if (wanted === "opencode") return "opencode";
  throw new MuseInvalidConfigError(
    `Invalid tool backend ${JSON.stringify(raw) ?? "?"}: set ${TOOL_BACKEND_OPTION} to "muse"/"opencode" (or ${TOOL_BACKEND_ENV} to muse/opencode), or leave it unset for the default ("muse").`,
  );
}
