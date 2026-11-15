import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Connection, EXPECTED_SCHEMA_FINGERPRINT, type MspHandshake } from "@muse-code/sdk";
import { MspHost } from "../../src/msp/host.js";
import { MuseRecoveryChoiceRequiredError } from "../../src/errors.js";
import { SessionRegistry } from "../../src/session/registry.js";
import { WorkspaceLock } from "../../src/session/workspace-lock.js";
import { MuseSessionManager } from "../../src/session/manager.js";
import { FakeMspTransport } from "../helpers/fake-msp.ts";
import { MspCommandTimeoutError, WorkspaceBusyError } from "../../src/errors.js";
import { createMuseLanguageModel } from "../../src/model/language-model.js";
import { addRequestContextHeaders } from "../../src/model/context.js";
import { openCodeModelId } from "../../src/catalog.js";
import type { MuseModelSelection, RequestContext } from "../../src/types.js";
import type { MuseSessionHost } from "../../src/session/manager.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "opencode-muse-recovery-"));
  roots.push(root);
  return root;
}

function requestContext(sessionID: string, directory: string): RequestContext {
  return {
    sessionID,
    directory,
    kind: "primary",
    modelID: "muse-profile-tbh-model-wonder",
    providerID: "muse",
    museSelection: {
      providerId: "meta",
      profileId: "tbh",
      modelId: "wonder",
      isActive: false,
      isDefault: true,
      defaultReasoningEffort: "high",
      variantsKnown: true,
      variants: ["high"],
    },
  };
}

function createManager(root: string, turnIsActive = false) {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  let hostCount = 0;
  let museId = 0;
  const registry = new SessionRegistry({ stateDirectory: root });
  const workspaceLock = new WorkspaceLock({ stateDirectory: root });
  const manager = new MuseSessionManager({
    stateDirectory: root,
    registry,
    workspaceLock,
    async createHost({ cwd, args }) {
      hostCount += 1;
      const transport = new FakeMspTransport((request) => {
        calls.push({ method: request.method, params: request.params ?? {} });
        if (request.method === "initialize") {
          return {
            experimentalApi: false,
            grantedCapabilities: [],
            museHome: "/fake/muse-home",
            platformFamily: "unix",
            platformOs: "linux",
            schema: { fingerprint: EXPECTED_SCHEMA_FINGERPRINT, version: 1 },
            serverInfo: { name: "muse", version: "1.4.11" },
            sessionDurability: "durable",
            userAgent: "fake",
          };
        }
        if (request.method === "session/start") {
          return {
            commandId: request.params?.commandId,
            session: { sessionId: `ses_muse_${++museId}`, activeTurnId: null },
            viewCursor: "cursor-start",
          };
        }
        if (request.method === "session/resume") {
          return {
            commandId: request.params?.commandId,
            session: { sessionId: request.params?.sessionId, activeTurnId: turnIsActive ? "turn-active" : null },
            viewCursor: "cursor-resume",
            history: { mode: "none" },
            pendingRequests: [],
          };
        }
        return { commandId: request.params?.commandId, status: "accepted" };
      });
      const connection = new Connection(transport);
      const handshake = {
        async initialize(params: Parameters<MspHandshake["initialize"]>[0]) {
          const initializeResult = await connection.request("initialize", {
            clientInfo: params.clientInfo,
            capabilities: params.capabilities,
          });
          return {
            connection,
            initializeResult,
            async close() { await connection.close(); },
          };
        },
        async close() { await connection.close(); },
      };
      return MspHost.start({ cwd, args }, { createHandshake: () => handshake });
    },
  });
  return { manager, registry, calls, get hostCount() { return hostCount; }, get museId() { return museId; } };
}

describe("Muse session crash recovery", () => {
});
