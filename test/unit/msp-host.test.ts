import { describe, expect, test } from "bun:test";
import { Connection, EXPECTED_SCHEMA_FINGERPRINT, type MspHandshake } from "@muse-code/sdk";
import { MspHost } from "../../src/msp/host.js";
import { MspCommandTimeoutError, MspSchemaMismatchError, MspStartupTimeoutError, MspTransportError } from "../../src/errors.js";
import { FakeMspTransport } from "../helpers/fake-msp.ts";

function fakeHandshake(
  transport: FakeMspTransport,
  initialized: Record<string, unknown> = { schema: { fingerprint: EXPECTED_SCHEMA_FINGERPRINT } },
  exited: Promise<unknown> = new Promise(() => {}),
) {
  let closeCount = 0;
  const connection = new Connection(transport);
  return {
    get closeCount() { return closeCount; },
    connection,
    handshake: {
      async initialize(params: Parameters<MspHandshake["initialize"]>[0]) {
        const result = await connection.request("initialize", { clientInfo: params.clientInfo, capabilities: params.capabilities });
        return {
          connection,
          initializeResult: Object.keys(result).length > 0 ? result : initialized,
          params,
          exited,
          async close() {
            closeCount += 1;
            await connection.close();
          },
        };
      },
      async close() {
        closeCount += 1;
      },
    },
  };
}

describe("MspHost", () => {
  test("mspHost.pinsMuse1414StableSchemaFingerprint", () => {
    expect(EXPECTED_SCHEMA_FINGERPRINT).toBe(
      "sha256:c94c3d1f2f51e6424074b9ec43eac3eedcf532d3dcd77351ec1383a87d3049c6",
    );
  });

  test("mspHost.initializesThePinnedSdkConnectionBeforeReturning", async () => {
    const transport = new FakeMspTransport((request) => request.method === "initialize"
      ? { schema: { fingerprint: EXPECTED_SCHEMA_FINGERPRINT } }
      : {});
    const fake = fakeHandshake(transport);
    const host = await MspHost.start({ cwd: "/workspace", startupTimeoutMs: 250 }, {
      createHandshake: () => fake.handshake,
    });

    const clientInfo = transport.requests.find((request) => request.method === "initialize")?.params?.clientInfo as { name?: string; version?: string };
    expect(clientInfo).toEqual({ name: "opencode_muse", version: "0.1.0" });
    expect(clientInfo.name).toMatch(/^[a-z0-9_]+$/);
    expect(host.initializeResult).toEqual({ schema: { fingerprint: EXPECTED_SCHEMA_FINGERPRINT } });
    expect(host.fingerprintWarning).toBeUndefined();
    await host.close();
    expect(fake.closeCount).toBe(1);
  });

  test("mspHost.sanitizesExplicitServeChildEnvBeforeHandshake", async () => {
    const transport = new FakeMspTransport((request) => request.method === "initialize"
      ? { schema: { fingerprint: EXPECTED_SCHEMA_FINGERPRINT } }
      : {});
    const fake = fakeHandshake(transport);
    let seenEnv: Record<string, string | undefined> | undefined;
    const host = await MspHost.start(
      { env: { KEEP: "1", META_API_KEY: "secret", MUSE_CONTRIBUTOR_MODE: "off" } },
      {
        createHandshake: (spawnOptions) => {
          seenEnv = { ...(spawnOptions.env ?? {}) };
          return fake.handshake;
        },
      },
    );
    expect(seenEnv?.KEEP).toBe("1");
    expect(seenEnv?.META_API_KEY).toBeUndefined();
    expect(seenEnv?.MUSE_CONTRIBUTOR_MODE).toBeUndefined();
    expect(seenEnv?.MUSE_NO_AUTO_UPDATE).toBe("1");
    await host.close();
  });

  test("mspHost.sanitizesDefaultServeChildEnvBeforeHandshake", async () => {
    const transport = new FakeMspTransport((request) => request.method === "initialize"
      ? { schema: { fingerprint: EXPECTED_SCHEMA_FINGERPRINT } }
      : {});
    const fake = fakeHandshake(transport);
    const previous = process.env.META_API_KEY;
    process.env.META_API_KEY = "secret";
    try {
      let seenEnv: Record<string, string | undefined> | undefined;
      const host = await MspHost.start({}, {
        createHandshake: (spawnOptions) => {
          seenEnv = { ...(spawnOptions.env ?? {}) };
          return fake.handshake;
        },
      });
      expect(seenEnv?.META_API_KEY).toBeUndefined();
      expect(seenEnv?.MUSE_NO_AUTO_UPDATE).toBe("1");
      await host.close();
    } finally {
      if (previous === undefined) delete process.env.META_API_KEY;
      else process.env.META_API_KEY = previous;
    }
  });

  test("mspHost.mintsCommandIdsFromItsOwnSdkConnection", async () => {
    const transport = new FakeMspTransport((request) => request.method === "initialize"
      ? { schema: { fingerprint: EXPECTED_SCHEMA_FINGERPRINT } }
      : {});
    const fake = fakeHandshake(transport);
    const host = await MspHost.start({}, { createHandshake: () => fake.handshake });
    const commandId = host.mintCommandId();

    expect(commandId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    await host.close();
  });

  test("mspHost.startTimeoutClosesTheHalfStartedHandshake", async () => {
    let closeCount = 0;
    const hostPromise = MspHost.start({ startupTimeoutMs: 10 }, {
      createHandshake: () => ({
        initialize: () => new Promise(() => {}),
        async close() { closeCount += 1; },
      }),
    });

    await expect(hostPromise).rejects.toBeInstanceOf(MspStartupTimeoutError);
    expect(closeCount).toBe(1);
  });

  test("mspHost.commandTimeoutPoisonsAndClosesTheAmbiguousHost", async () => {
    const transport = new FakeMspTransport((request) => request.method === "initialize"
      ? { schema: { fingerprint: EXPECTED_SCHEMA_FINGERPRINT } }
      : new Promise(() => {}));
    const fake = fakeHandshake(transport);
    const host = await MspHost.start({ commandTimeoutMs: 10 }, { createHandshake: () => fake.handshake });

    await expect(host.command("turn/start", {
      commandId: "018f4f17-9c2a-7c1a-a0fd-67a19db5c004",
      sessionId: "ses_probe",
      input: [{ type: "text", text: "probe" }],
    })).rejects.toBeInstanceOf(MspCommandTimeoutError);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(host.isClosed).toBe(true);
    expect(fake.closeCount).toBe(1);
  });

  test("mspHost.forwardsStartResumeAndForkWithTheirExactCommandIds", async () => {
    const transport = new FakeMspTransport((request) => request.method === "initialize"
      ? { schema: { fingerprint: EXPECTED_SCHEMA_FINGERPRINT } }
      : {});
    const fake = fakeHandshake(transport);
    const host = await MspHost.start({}, { createHandshake: () => fake.handshake });
    const ids = [
      "018f4f17-9c2a-7c1a-a0fd-67a19db5c010",
      "018f4f17-9c2a-7c1a-a0fd-67a19db5c011",
      "018f4f17-9c2a-7c1a-a0fd-67a19db5c012",
    ];

    await host.command("session/start", { commandId: ids[0]!, workspaceRoot: "/workspace" });
    await host.command("session/resume", { commandId: ids[1]!, sessionId: "ses_probe" });
    await host.command("session/fork", { commandId: ids[2]!, sessionId: "ses_probe", cutPoint: { lastTurnId: "turn-1" } });

    expect(transport.requests.filter((request) => ["session/start", "session/resume", "session/fork"].includes(request.method))
      .map((request) => request.params?.commandId)).toEqual(ids);
    await host.close();
  });

  test("mspHost.autoApprovesTheFirstOfferedApproveChoiceWithNoPrompt", async () => {
    const transport = new FakeMspTransport((request) => request.method === "initialize"
      ? { schema: { fingerprint: EXPECTED_SCHEMA_FINGERPRINT } }
      : {});
    const fake = fakeHandshake(transport);
    const host = await MspHost.start({}, { createHandshake: () => fake.handshake });

    transport.deliver({
      jsonrpc: "2.0",
      id: 901,
      method: "approval/request",
      params: {
        approvalId: "appr_1",
        sessionId: "ses_muse_1",
        currentRequirementId: { approvalId: "appr_1", sourceIndex: 0 },
        availableChoices: [
          { choiceId: "reject-once", decision: "reject", scope: "once", label: "Reject" },
          { choiceId: "allow-persistent", decision: "approve", scope: "localPersistent", label: "Always" },
          { choiceId: "allow-once", decision: "approve", scope: "once", label: "Once" },
        ],
      },
    });

    const decide = await transport.waitForRequest((request) => request.method === "approval/decide");
    expect(decide.params).toMatchObject({
      sessionId: "ses_muse_1",
      approvalId: "appr_1",
      requirementId: { approvalId: "appr_1", sourceIndex: 0 },
      choiceId: "allow-persistent",
    });
    await host.close();
  });

  test("mspHost.approvalWithoutAnApproveChoiceIsAckedWithoutFurtherCommands", async () => {
    const transport = new FakeMspTransport((request) => request.method === "initialize"
      ? { schema: { fingerprint: EXPECTED_SCHEMA_FINGERPRINT } }
      : {});
    const fake = fakeHandshake(transport);
    const host = await MspHost.start({}, { createHandshake: () => fake.handshake });

    transport.deliver({
      jsonrpc: "2.0",
      id: 902,
      method: "approval/request",
      params: {
        approvalId: "appr_2",
        sessionId: "ses_muse_1",
        currentRequirementId: { approvalId: "appr_2", sourceIndex: 0 },
        availableChoices: [{ choiceId: "reject-once", decision: "reject", scope: "once", label: "Reject" }],
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(transport.requests.some((request) => request.method === "approval/decide")).toBe(false);
    expect(transport.requests.some((request) => request.method === "turn/interrupt")).toBe(false);
    await host.close();
  });

  test("mspHost.autoCancelsUserInputRequests", async () => {
    const transport = new FakeMspTransport((request) => request.method === "initialize"
      ? { schema: { fingerprint: EXPECTED_SCHEMA_FINGERPRINT } }
      : {});
    const fake = fakeHandshake(transport);
    const host = await MspHost.start({}, { createHandshake: () => fake.handshake });

    transport.deliver({
      jsonrpc: "2.0",
      id: 903,
      method: "userInput/request",
      params: { sessionId: "ses_muse_1", userInputId: "ui_1", questions: [] },
    });

    const cancel = await transport.waitForRequest((request) => request.method === "userInput/cancel");
    expect(cancel.params).toMatchObject({ sessionId: "ses_muse_1", userInputId: "ui_1", reason: "cancelled" });
    expect(transport.requests.some((request) => request.method === "userInput/answer")).toBe(false);
    await host.close();
  });

  test("mspHost.closeIsIdempotent", async () => {
    const transport = new FakeMspTransport((request) => request.method === "initialize"
      ? { schema: { fingerprint: EXPECTED_SCHEMA_FINGERPRINT } }
      : {});
    const fake = fakeHandshake(transport);
    const host = await MspHost.start({}, { createHandshake: () => fake.handshake });
    await Promise.all([host.close(), host.close(), host.close()]);
    expect(fake.closeCount).toBe(1);
  });

  test("mspHost.exposesOnlySanitizedChildExitFields", async () => {
    const transport = new FakeMspTransport((request) => request.method === "initialize"
      ? { schema: { fingerprint: EXPECTED_SCHEMA_FINGERPRINT } }
      : {});
    const fake = fakeHandshake(transport, { schema: { fingerprint: EXPECTED_SCHEMA_FINGERPRINT } }, Promise.resolve({
      kind: "crash",
      exitCode: 3,
      exitSignal: null,
      stderrTail: ["credential-looking-value"],
    }));
    const host = await MspHost.start({}, { createHandshake: () => fake.handshake });
    const exit = await host.exited;

    expect(exit).toEqual({ kind: "crash", exitCode: 3, exitSignal: null });
    expect(JSON.stringify(exit)).not.toContain("credential-looking-value");
    expect(host.isClosed).toBe(true);
  });

  test("mspHost.startsWithAWarningOnChangedServedFingerprintAndKeepsTheRuntimeOpen", async () => {
    const servedFingerprint = "sha256:7fddaf646dbc317e5fcac0785e135eb04df14fbb0db1863089dfd6da21730e5b";
    const transport = new FakeMspTransport((request) => request.method === "initialize"
      ? { schema: { fingerprint: servedFingerprint } }
      : {});
    const fake = fakeHandshake(transport);

    const host = await MspHost.start({}, { createHandshake: () => fake.handshake });

    expect(host.fingerprintWarning?.served).toBe(servedFingerprint);
    expect(host.fingerprintWarning?.pinned).toBe(EXPECTED_SCHEMA_FINGERPRINT);
    expect(fake.closeCount).toBe(0);
    await host.close();
    expect(fake.closeCount).toBe(1);
  });

  test("mspHost.rejectsAMissingOrMalformedServedFingerprintAndClosesTheRuntime", async () => {
    for (const schema of [{ fingerprint: "sha256:changed" }, {}]) {
      const transport = new FakeMspTransport((request) => request.method === "initialize"
        ? { schema }
        : {});
      const fake = fakeHandshake(transport);

      await expect(MspHost.start({}, { createHandshake: () => fake.handshake }))
        .rejects.toBeInstanceOf(MspSchemaMismatchError);
      expect(fake.closeCount).toBe(1);
    }
  });

  test("mspHost.rejectsAnUnsupportedEnvelopeVersionAndClosesTheRuntime", async () => {
    const transport = new FakeMspTransport((request) => request.method === "initialize"
      ? { schema: { fingerprint: EXPECTED_SCHEMA_FINGERPRINT, version: 999 } }
      : {});
    const fake = fakeHandshake(transport);

    await expect(MspHost.start({}, { createHandshake: () => fake.handshake }))
      .rejects.toBeInstanceOf(MspSchemaMismatchError);
    expect(fake.closeCount).toBe(1);
  });

  test("mspHost.closeReportsFailureWithoutLeakingRuntimeText", async () => {
    const transport = new FakeMspTransport((request) => request.method === "initialize"
      ? { schema: { fingerprint: EXPECTED_SCHEMA_FINGERPRINT } }
      : {});
    const connection = new Connection(transport);
    const host = await MspHost.start({}, {
      createHandshake: () => ({
        async initialize(params: Parameters<MspHandshake["initialize"]>[0]) {
          const initializeResult = await connection.request("initialize", {
            clientInfo: params.clientInfo,
            capabilities: params.capabilities,
          });
          return {
            connection,
            initializeResult,
            async close() { throw new Error("credential-looking-value"); },
          };
        },
        async close() {},
      }),
    });

    await expect(host.close()).rejects.toBeInstanceOf(MspTransportError);
    expect(host.isClosed).toBe(true);
  });

  test("mspHost.closesTheChildAfterAProtocolViolation", async () => {
    const transport = new FakeMspTransport((request) => request.method === "initialize"
      ? { schema: { fingerprint: EXPECTED_SCHEMA_FINGERPRINT } }
      : {});
    const fake = fakeHandshake(transport);
    const host = await MspHost.start({}, { createHandshake: () => fake.handshake });
    transport.deliverRaw("not-json");

    for (let attempt = 0; attempt < 20 && !host.isClosed; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    expect(host.isClosed).toBe(true);
    expect(fake.closeCount).toBe(1);
  });
});
