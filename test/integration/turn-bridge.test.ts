import { describe, expect, test } from "bun:test";
import { Connection, EXPECTED_SCHEMA_FINGERPRINT, type MspHandshake } from "@muse-code/sdk";
import { MspHost } from "../../src/msp/host.js";
import { createMuseLanguageModel } from "../../src/model/language-model.js";
import { addRequestContextHeaders } from "../../src/model/context.js";
import { openCodeModelId } from "../../src/catalog.js";
import { FakeMspTransport } from "../helpers/fake-msp.ts";
import type { MuseModelSelection } from "../../src/types.js";

const modelId = openCodeModelId("tbh", "muse-wonder-1.0");
const selection: MuseModelSelection = {
  providerId: "meta",
  profileId: "tbh",
  modelId: "muse-wonder-1.0",
  isActive: true,
  isDefault: true,
  defaultReasoningEffort: "high",
  variantsKnown: true,
  variants: ["high"],
};

function makeContext() {
  const headers: Record<string, string> = {};
  addRequestContextHeaders(headers, {
    sessionID: "ses_fake_bridge",
    kind: "primary",
    model: { id: modelId, providerID: "muse", variant: "high" },
    headers,
  }, "/tmp/opencode/fake-bridge");
  return {
    prompt: [{ role: "user", content: [{ type: "text", text: "Bridge test input." }] }],
    headers,
    tools: [{ type: "function", name: "shell", inputSchema: { type: "object", properties: {} } }],
    toolChoice: { type: "auto" },
  } as never;
}

describe("fake MSP ↔ LanguageModelV3 bridge integration", () => {
});
