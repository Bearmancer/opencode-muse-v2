import { createHash } from "node:crypto";

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, child]) => child !== undefined)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`).join(",")}}`;
}


export function notificationCursorKey(notification: {
  method: string;
  params?: Record<string, unknown>;
}): string | undefined {
  const params = notification.params ?? {};
  const cursor = params.viewCursor;
  if (typeof cursor !== "string") return undefined;
  const digest = createHash("sha256")
    .update(stableJson({ method: notification.method, params }))
    .digest("hex");
  return `${cursor}:${digest}`;
}
