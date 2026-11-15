import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionRegistry } from "../../src/session/registry.js";
import { WorkspaceLock } from "../../src/session/workspace-lock.js";
import { MuseSessionManager } from "../../src/session/manager.js";
import { MspCommandRejectedError, MspCommandTimeoutError, MuseInvalidConfigError, WorkspaceBusyError, MuseRecoveryChoiceRequiredError } from "../../src/errors.js";
import type { ContributorMode } from "../../src/msp/contributor.js";
import type { RequestContext } from "../../src/types.js";

const roots: string[] = [];
const workspaceFingerprint = (directory: string) => createHash("sha256").update(directory).digest("hex");

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const path = mkdtempSync(join(tmpdir(), "opencode-muse-manager-"));
  roots.push(path);
  return path;
}

function context(sessionID: string, directory: string): RequestContext {
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

function managerAt(
  root: string,
  failSetModel = false,
  resumeActiveTurn = false,
  registryOverride?: SessionRegistry,
  workspaceLockOverride?: WorkspaceLock,
  closeGate?: { started(): void; wait: Promise<void> },
  contributorMode?: ContributorMode,
  toolBackend?: "muse" | "opencode",
  rejectCommands?: Record<string, { code: number; kind: string }>,
) {
  let id = 0;
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const hostOptions: Array<Record<string, unknown>> = [];
  const hosts: Array<{ closeCount: number }> = [];
  const registry = registryOverride ?? new SessionRegistry({ stateDirectory: root });
  const manager = new MuseSessionManager({
    stateDirectory: root,
    registry,
    workspaceLock: workspaceLockOverride ?? new WorkspaceLock({ stateDirectory: root }),
    contributorMode,
    toolBackend,
    async createHost(options) {
      hostOptions.push(options as unknown as Record<string, unknown>);
      const record = { closeCount: 0 };
      hosts.push(record);
      return {
        initializeResult: { sessionDurability: "durable" },
        mintCommandId: () => `018f4f17-9c2a-7c1a-a0fd-67a19db5d1${String(id++).padStart(2, "0")}`,
        async command(method: string, params: Record<string, unknown>) {
          calls.push({ method, params });
          const rejection = rejectCommands?.[method];
          if (rejection) throw new MspCommandRejectedError(method, rejection.code, rejection.kind);
          if (failSetModel && method === "session/setModel") {
            throw new MspCommandTimeoutError(method, 10);
          }
          if (method === "session/start") {
            return { session: { sessionId: `ses_muse_${calls.length}`, activeTurnId: null }, viewCursor: "head-1" };
          }
          if (method === "session/resume") {
            return {
              session: { sessionId: params.sessionId, activeTurnId: resumeActiveTurn ? "turn_unknown" : null },
              viewCursor: "resumed-head",
            };
          }
          if (method === "session/setModel") return { commandId: params.commandId, status: "accepted" };
          if (method === "session/fork") {
            return {
              session: { sessionId: `ses_muse_fork_${calls.length}`, activeTurnId: null },
              viewCursor: "fork-head",
              history: {},
              pendingRequests: [],
            };
          }
          return {};
        },
        async request() { return {}; },
        subscribe() { return { async *[Symbol.asyncIterator]() {} }; },
        async close() {
          record.closeCount += 1;
          closeGate?.started();
          await closeGate?.wait;
        },
        options,
      } as never;
    },
  });
  return { manager, calls, hosts, hostOptions };
}

describe("MuseSessionManager", () => {
  test("sessionManager.rejectsSecondOpenCodeWriterForSameWorkspace", async () => {
    const root = tempRoot();
    const { manager } = managerAt(root);
    const directory = join(root, "project");
    mkdirSync(directory);
    const first = await manager.resolveSession(context("ses_oc_1", directory));

    await expect(manager.resolveSession(context("ses_oc_2", directory))).rejects.toBeInstanceOf(WorkspaceBusyError);
    await first.release?.();
    await manager.close();
  });

  test("sessionManager.resumesOnlyAStoredDurableSessionAtItsObservedCursor", async () => {
    const root = tempRoot();
    const directory = join(root, "project");
    mkdirSync(directory);
    const first = managerAt(root);
    const binding = await first.manager.resolveSession(context("ses_oc_1", directory));
    await binding.release?.();
    await first.manager.close();

    const restarted = managerAt(root);
    const resumed = await restarted.manager.resolveSession(context("ses_oc_1", directory));

    const resumeCall = restarted.calls.find((call) => call.method === "session/resume");
    expect(resumeCall?.params).toMatchObject({ sessionId: binding.sessionId, cursor: "head-1" });
    expect(restarted.calls.some((call) => call.method === "session/start")).toBe(false);
    expect(resumed.sessionId).toBe(binding.sessionId);
    await resumed.release?.();
    await restarted.manager.close();
  });

  test("sessionManager.appliesProfileAndModelChangesToTheExistingMuseSession", async () => {
    const root = tempRoot();
    const directory = join(root, "project");
    mkdirSync(directory);
    const { manager, calls } = managerAt(root);
    const first = await manager.resolveSession(context("ses_oc_1", directory));
    await first.release?.();
    const changed = context("ses_oc_1", directory);
    changed.museSelection = {
      ...changed.museSelection,
      providerId: "meta",
      profileId: "other-profile",
      modelId: "spark",
    };
    const second = await manager.resolveSession(changed);

    expect(calls.filter((call) => call.method === "session/start")).toHaveLength(1);
    expect(calls.filter((call) => call.method === "session/setModel")).toHaveLength(2);
    expect(calls.filter((call) => call.method === "session/setModel").at(-1)?.params.model).toEqual({
      providerId: "meta",
      profileId: "other-profile",
      modelId: "spark",
    });
    expect(second.sessionId).toBe(first.sessionId);
    await second.release?.();
    await manager.close();
  });

  test("sessionManager.persistsOnlyTheCompactionCandidateHash", async () => {
    const root = tempRoot();
    const directory = join(root, "project");
    mkdirSync(directory);
    const { manager } = managerAt(root);
    const binding = await manager.resolveSession(context("ses_oc_1", directory));
    const candidate = "9".repeat(64);

    await expect(manager.recordCompactionCandidate("ses_oc_1", candidate)).rejects.toBeInstanceOf(WorkspaceBusyError);
    await binding.release?.();
    await manager.recordCompactionCandidate("ses_oc_1", candidate);
    const entry = await new SessionRegistry({ stateDirectory: root }).get("ses_oc_1", workspaceFingerprint(directory));
    expect(entry?.compactionFingerprints).toEqual([candidate]);
    expect(JSON.stringify(entry)).not.toContain("summary body");
    await binding.commitTranscriptFingerprints?.(["a".repeat(64)]);
    const committed = await new SessionRegistry({ stateDirectory: root }).get("ses_oc_1", workspaceFingerprint(directory));
    expect(committed?.compactionFingerprints).toEqual([]);
    expect(committed?.transcriptFingerprints).toEqual(["a".repeat(64)]);
    await manager.close();
  });

  test("sessionManagerKeepsAllowlistedAgentInstructionsInMemoryOnly", async () => {
    const root = tempRoot();
    const directory = join(root, "project");
    mkdirSync(directory);
    const { manager } = managerAt(root);
    manager.setContextForSession("ses_oc_1", {
      supported: true,
      fragments: [{ label: "OpenCode agent instructions", text: "Never print the private deployment token." }],
    });
    const binding = await manager.resolveSession(context("ses_oc_1", directory));

    expect(binding.contextAllowlist).toEqual([
      { label: "OpenCode agent instructions", text: "Never print the private deployment token." },
    ]);
    const saved = await new SessionRegistry({ stateDirectory: root }).get("ses_oc_1", workspaceFingerprint(directory));
    expect(JSON.stringify(saved)).not.toContain("private deployment token");
    await binding.release?.();
    await manager.close();
  });

  test("sessionManager.clearsAcknowledgedCommandFingerprintsAtTerminalAfterCleanupWriteFailure", async () => {
    const root = tempRoot();
    const directory = join(root, "project");
    mkdirSync(directory);
    const registry = new SessionRegistry({ stateDirectory: root });
    const clear = registry.clearPendingCommand.bind(registry);
    let failNextClear = true;
    registry.clearPendingCommand = async (...args: Parameters<SessionRegistry["clearPendingCommand"]>) => {
      if (failNextClear) {
        failNextClear = false;
        throw new Error("temporary state write failure");
      }
      return clear(...args);
    };
    const { manager } = managerAt(root, false, false, registry);
    const ctx = context("ses_oc_1", directory);
    ctx.museSelection = { ...ctx.museSelection, profileId: null };
    const binding = await manager.resolveSession(ctx);
    const commandId = "018f4f17-9c2a-7c1a-a0fd-67a19db5d1f9";
    await binding.recordPendingCommand?.({ commandId, method: "turn/start", fingerprint: "c".repeat(64) });
    await expect(binding.clearPendingCommand?.(commandId)).rejects.toThrow("temporary state write failure");
    await binding.recordTurnAccepted?.(commandId, "turn_running");
    await binding.recordTurnCompleted?.("turn_running", "completed");

    const entry = await registry.get("ses_oc_1", workspaceFingerprint(directory));
    expect(entry?.pendingCommands).toEqual({});
    expect(entry?.activeTurnId).toBeUndefined();
    await binding.release?.();
    await manager.close();
  });

  test("sessionManager.keepsMonitoringWhenAPerEventCursorWriteFails", async () => {
    const root = tempRoot();
    const directory = join(root, "project");
    mkdirSync(directory);
    const registry = new SessionRegistry({ stateDirectory: root });
    const { manager } = managerAt(root, false, false, registry);
    const binding = await manager.resolveSession(context("ses_oc_1", directory));
    const update = registry.updateCursor.bind(registry);
    registry.updateCursor = async () => { throw new Error("disk temporarily unavailable"); };

    await expect(binding.updateCursor?.("cursor-unpersisted")).resolves.toBeUndefined();
    registry.updateCursor = update;
    expect((await registry.get("ses_oc_1", workspaceFingerprint(directory)))?.viewCursor).toBe("head-1");
    await binding.release?.();
    await manager.close();
  });

  test("sessionManager.keepsTheWorkspaceLockUntilHostShutdownCompletes", async () => {
    const root = tempRoot();
    const directory = join(root, "project");
    mkdirSync(directory);
    const lock = new WorkspaceLock({ stateDirectory: root });
    let markHostClosing!: () => void;
    let finishHostClose!: () => void;
    const hostClosing = new Promise<void>((resolve) => { markHostClosing = resolve; });
    const hostCloseGate = new Promise<void>((resolve) => { finishHostClose = resolve; });
    const { manager } = managerAt(root, false, false, undefined, lock, {
      started: markHostClosing,
      wait: hostCloseGate,
    });
    const binding = await manager.resolveSession(context("ses_oc_1", directory));
    const closing = manager.close();
    await hostClosing;

    await expect(lock.acquire(workspaceFingerprint(directory), "ses_other"))
      .rejects.toBeInstanceOf(WorkspaceBusyError);
    finishHostClose();
    await closing;
    const lease = await lock.acquire(workspaceFingerprint(directory), "ses_other");
    await lease.release();
    await binding.release?.();
  });

  test("sessionManager.rejectsWorkspaceChangeForAnExistingOpenCodeSession", async () => {
    const root = tempRoot();
    const { manager } = managerAt(root);
    const directoryA = join(root, "project-a");
    const directoryB = join(root, "project-b");
    mkdirSync(directoryA);
    mkdirSync(directoryB);
    const first = await manager.resolveSession(context("ses_oc_1", directoryA));
    await first.release?.();

    await expect(manager.resolveSession(context("ses_oc_1", directoryB)))
      .rejects.toThrow(/different workspace/);
    await manager.close();
  });

  function parkApproval(exchange: ApprovalExchange, sessionId: string, turnId: string, approvalId = "approval-9") {
    return exchange.requestApproval({
      sessionId,
      turnId,
      approvalId,
      currentRequirementId: "req-1",
      availableChoices: [],
      toolCallId: "call-9",
    });
  }

  test("sessionManager.marksFollowUpResolveForSteeringIntoTheLiveTurn", async () => {
    const root = tempRoot();
    const { manager, calls } = managerAt(root);
    const directory = join(root, "project");
    mkdirSync(directory);
    const first = await manager.resolveSession(context("ses_oc_1", directory));
    await first.recordTurnAccepted?.("cmd-1", "turn-1");

    const second = await manager.resolveSession(context("ses_oc_1", directory));
    expect(second).toBe(first);
    expect(second.steerExpectedTurnId).toBe("turn-1");
    expect(calls.filter((call) => call.method === "session/start")).toHaveLength(1);
    await manager.close();
  });

});

describe("rewind/fork anchors and explicit-cut fork", () => {
  const fa = "a".repeat(64);
  const fb = "b".repeat(64);
  const fc = "c".repeat(64);
  const fd = "d".repeat(64);
  const fe = "e".repeat(64);

  async function seed(root: string, sessionID: string, directory: string, overrides: Record<string, unknown> = {}) {
    const registry = new SessionRegistry({ stateDirectory: root });
    await registry.put({
      openCodeSessionId: sessionID,
      museSessionId: "ses_muse_parent",
      hostId: "host_seed",
      workspaceFingerprint: workspaceFingerprint(directory),
      providerId: "meta",
      modelId: "wonder",
      transcriptFingerprints: [],
      compactionFingerprints: [],
      pendingCommands: {},
      ...overrides,
    } as never);
  }

  async function storedFor(root: string, sessionID: string, directory: string) {
    return new SessionRegistry({ stateDirectory: root }).get(sessionID, workspaceFingerprint(directory));
  }

  test("sessionManager.recordsAnchorsForCleanTurnsOnly", async () => {
    const root = tempRoot();
    const { manager } = managerAt(root);
    const directory = join(root, "project");
    mkdirSync(directory);
    const binding = await manager.resolveSession(context("ses_oc_1", directory));
    await binding.recordTurnAccepted?.("018f4f17-9c2a-7c1a-a0fd-67a19db5d100", "turn-1");
    await binding.recordTurnCompleted?.("turn-1", "completed");
    await binding.commitTranscriptFingerprints?.([fa, fb]);
    await binding.recordTurnAccepted?.("018f4f17-9c2a-7c1a-a0fd-67a19db5d101", "turn-2");
    await binding.recordTurnCompleted?.("turn-2", "cancelled");
    await binding.recordTurnAccepted?.("018f4f17-9c2a-7c1a-a0fd-67a19db5d102", "turn-3");
    await binding.recordTurnCompleted?.("turn-3", "completed");
    await binding.commitTranscriptFingerprints?.([fa, fb, fc, fd]);

    expect((await storedFor(root, "ses_oc_1", directory))?.turnAnchors).toEqual([
      { sequenceLength: 2, turnId: "turn-1" },
      { sequenceLength: 4, turnId: "turn-3" },
    ]);
    await manager.close();
  });

  test("sessionManager.resetsAnchorsWhenCommitReplacesHistory", async () => {
    const root = tempRoot();
    const { manager } = managerAt(root);
    const directory = join(root, "project");
    mkdirSync(directory);
    const binding = await manager.resolveSession(context("ses_oc_1", directory));
    await binding.recordTurnAccepted?.("018f4f17-9c2a-7c1a-a0fd-67a19db5d100", "turn-1");
    await binding.recordTurnCompleted?.("turn-1", "completed");
    await binding.commitTranscriptFingerprints?.([fa, fb]);
    await binding.recordTurnAccepted?.("018f4f17-9c2a-7c1a-a0fd-67a19db5d101", "turn-9");
    await binding.recordTurnCompleted?.("turn-9", "completed");
    await binding.commitTranscriptFingerprints?.([fe]);

    expect((await storedFor(root, "ses_oc_1", directory))?.turnAnchors).toEqual([
      { sequenceLength: 1, turnId: "turn-9" },
    ]);
    await manager.close();
  });

  test("sessionManager.forksAtRetainedCutAndRepoints", async () => {
    const root = tempRoot();
    const directory = join(root, "project");
    mkdirSync(directory);
    await seed(root, "ses_oc_1", directory, {
      transcriptFingerprints: [fa, fb, fc, fd],
      turnAnchors: [
        { sequenceLength: 2, turnId: "turn-1" },
        { sequenceLength: 4, turnId: "turn-2" },
      ],
    });
    const { manager, calls } = managerAt(root);
    const binding = await manager.resolveSession(context("ses_oc_1", directory));

    const result = await manager.forkSessionAtBoundary("ses_oc_1", 2);

    expect(result).toEqual({ forked: true });
    const fork = calls.find((call) => call.method === "session/fork");
    expect(fork?.params).toMatchObject({ sessionId: "ses_muse_parent", cutPoint: { lastTurnId: "turn-1" } });
    expect(typeof fork?.params.commandId).toBe("string");
    const stored = await storedFor(root, "ses_oc_1", directory);
    expect(stored?.museSessionId).toMatch(/^ses_muse_fork_/);
    
    
    expect(stored?.turnAnchors).toEqual([]);
    expect(stored?.transcriptFingerprints).toEqual([fa, fb]);
    expect(binding.sessionId).toBe(stored?.museSessionId);
    await manager.close();
  });

  test("sessionManager.rejectsUnmappableBoundaryWithoutFork", async () => {
    const root = tempRoot();
    const directory = join(root, "project");
    mkdirSync(directory);
    await seed(root, "ses_oc_1", directory, {
      transcriptFingerprints: [fa, fb, fc, fd],
      turnAnchors: [
        { sequenceLength: 2, turnId: "turn-1" },
        { sequenceLength: 4, turnId: "turn-2" },
      ],
    });
    const { manager, calls } = managerAt(root);
    await manager.resolveSession(context("ses_oc_1", directory));

    const result = await manager.forkSessionAtBoundary("ses_oc_1", 3);

    expect(result).toEqual({ forked: false });
    expect(calls.filter((call) => call.method === "session/fork")).toHaveLength(0);
    await manager.close();
  });

  test("sessionManager.adoptsKnownTranscriptForNewSession", async () => {
    const root = tempRoot();
    const directory = join(root, "project");
    mkdirSync(directory);
    await seed(root, "ses_oc_parent", directory, {
      transcriptFingerprints: [fa, fb, fc, fd],
      turnAnchors: [
        { sequenceLength: 2, turnId: "turn-1" },
        { sequenceLength: 4, turnId: "turn-2" },
      ],
    });
    const { manager, calls } = managerAt(root);

    const binding = await manager.resolveSession(context("ses_oc_child", directory), { incomingFingerprints: [fa, fb, fc, fd] });

    expect(calls.filter((call) => call.method === "session/start")).toHaveLength(0);
    const fork = calls.find((call) => call.method === "session/fork");
    expect(fork?.params).toMatchObject({ sessionId: "ses_muse_parent" });
    expect("cutPoint" in (fork?.params ?? {})).toBe(false);
    expect(binding.sessionId).toMatch(/^ses_muse_fork_/);
    expect((await storedFor(root, "ses_oc_child", directory))?.turnAnchors).toEqual([]);
    await manager.close();
  });

  test("sessionManager.opencodeBackendRejectsArrayToolSchema", async () => {
    const root = tempRoot();
    const directory = join(root, "project");
    mkdirSync(directory);
    const previousHome = process.env.HOME;
    process.env.HOME = root;
    try {
      const { manager } = managerAt(root, false, false, undefined, undefined, undefined, undefined, "opencode");
      const binding = await manager.resolveSession(context("ses_oc_1", directory));

      expect(() =>
        binding.syncLoopbackTools?.([{ name: "opencode_write", description: "w", inputSchema: [] }]),
      ).toThrow(/tools/);
      expect(() =>
        binding.syncLoopbackTools?.([{ name: "opencode_write", description: "w", inputSchema: { type: "object" } }]),
      ).not.toThrow();
      await manager.close();
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }
  });

  test("sessionManager.opencodeBackendSweepKeepsLiveBinding", async () => {
    const root = tempRoot();
    const directoryA = join(root, "project-a");
    const directoryB = join(root, "project-b");
    mkdirSync(directoryA);
    mkdirSync(directoryB);
    const previousHome = process.env.HOME;
    process.env.HOME = root;
    try {
      const { manager } = managerAt(root, false, false, undefined, undefined, undefined, undefined, "opencode");
      await manager.resolveSession(context("ses_oc_a", directoryA));
      const hosts = join(root, "hosts");
      const control = join(hosts, "ses_control", "muse");
      mkdirSync(control, { recursive: true });
      const past = new Date(Date.now() - 25 * 60 * 60 * 1000);
      utimesSync(join(hosts, "ses_oc_a"), past, past);
      utimesSync(join(hosts, "ses_control"), past, past);

      await manager.resolveSession(context("ses_oc_b", directoryB));

      expect(existsSync(join(hosts, "ses_oc_a"))).toBe(true);
      expect(existsSync(join(hosts, "ses_control"))).toBe(false);
      await manager.close();
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }
  });

  test("sessionManager.opencodeBackendStartNamesMissingSessionMcpGrant", async () => {
    const root = tempRoot();
    const directory = join(root, "project");
    mkdirSync(directory);
    const previousHome = process.env.HOME;
    process.env.HOME = root;
    try {
      const { manager } = managerAt(root, false, false, undefined, undefined, undefined, undefined, "opencode", {
        "session/start": { code: -32010, kind: "capabilityRequired" },
      });
      await expect(manager.resolveSession(context("ses_oc_1", directory))).rejects.toThrow(/sessionMcp/);
      await manager.close();
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }
  });

  test("sessionManager.opencodeBackendResumeNamesMissingSessionMcpGrant", async () => {
    const root = tempRoot();
    const directory = join(root, "project");
    mkdirSync(directory);
    const registry = new SessionRegistry({ stateDirectory: root });
    await registry.put({
      openCodeSessionId: "ses_oc_1",
      museSessionId: "ses_muse_old",
      hostId: "host_seed",
      workspaceFingerprint: workspaceFingerprint(directory),
      providerId: "meta",
      modelId: "wonder",
      transcriptFingerprints: [],
      compactionFingerprints: [],
      pendingCommands: {},
    } as never);
    const previousHome = process.env.HOME;
    process.env.HOME = root;
    try {
      const { manager } = managerAt(root, false, false, undefined, undefined, undefined, undefined, "opencode", {
        "session/resume": { code: -32010, kind: "capabilityRequired" },
      });
      await expect(manager.resolveSession(context("ses_oc_1", directory))).rejects.toThrow(/sessionMcp/);
      await manager.close();
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }
  });

  test("sessionManager.museBackendStartRejectionStaysUntouched", async () => {
    const root = tempRoot();
    const directory = join(root, "project");
    mkdirSync(directory);
    const { manager } = managerAt(root, false, false, undefined, undefined, undefined, undefined, undefined, {
      "session/start": { code: -32010, kind: "capabilityRequired" },
    });
    const error = await manager.resolveSession(context("ses_oc_1", directory)).then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(MspCommandRejectedError);
    expect(error).not.toBeInstanceOf(MuseInvalidConfigError);
    await manager.close();
  });

  test("sessionManager.ambiguousTranscriptStaysFresh", async () => {
    const root = tempRoot();
    const directory = join(root, "project");
    mkdirSync(directory);
    await seed(root, "ses_oc_p1", directory, { transcriptFingerprints: [fa, fb] });
    await seed(root, "ses_oc_p2", directory, { transcriptFingerprints: [fa, fb] });
    const { manager, calls } = managerAt(root);

    await manager.resolveSession(context("ses_oc_child", directory), { incomingFingerprints: [fa, fb] });

    expect(calls.filter((call) => call.method === "session/start")).toHaveLength(1);
    expect(calls.filter((call) => call.method === "session/fork")).toHaveLength(0);
    await manager.close();
  });
});

describe("MuseSessionManager unattended posture", () => {
  test("sessionManager.museBackendAlwaysStartsAllowAll", async () => {
    const root = tempRoot();
    const directory = join(root, "project");
    mkdirSync(directory);
    const { manager, calls } = managerAt(root);
    const binding = await manager.resolveSession(context("ses_oc_1", directory));

    const start = calls.find((call) => call.method === "session/start");
    expect(start?.params.approvalMode).toBe("allowAll");
    expect("config" in (start?.params ?? {})).toBe(false);
    await binding.release?.();
    await manager.close();
  });

  test("sessionManager.opencodeBackendAlsoStartsAllowAll", async () => {
    const root = tempRoot();
    const directory = join(root, "project");
    mkdirSync(directory);
    const previousHome = process.env.HOME;
    process.env.HOME = root;
    try {
      const { manager, calls } = managerAt(root, false, false, undefined, undefined, undefined, undefined, "opencode");
      const binding = await manager.resolveSession(context("ses_oc_1", directory));

      const start = calls.find((call) => call.method === "session/start");
      expect(start?.params.approvalMode).toBe("allowAll");
      await binding.release?.();
      await manager.close();
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }
  });

  test("sessionManager.staleTurnEntryIsAbandonedAutomaticallyWithoutAQuestion", async () => {
    const root = tempRoot();
    const directory = join(root, "project");
    mkdirSync(directory);
    const registry = new SessionRegistry({ stateDirectory: root });
    await registry.put({
      openCodeSessionId: "ses_oc_1",
      museSessionId: "ses_muse_old",
      hostId: "host_seed",
      workspaceFingerprint: workspaceFingerprint(directory),
      providerId: "meta",
      modelId: "wonder",
      transcriptFingerprints: [],
      compactionFingerprints: [],
      pendingCommands: { "018f4f17-9c2a-7c1a-a0fd-67a19db5d1aa": { method: "turn/start", fingerprint: "a".repeat(64) } },
    } as never);
    const { manager, calls } = managerAt(root, false, false, registry);

    const binding = await manager.resolveSession(context("ses_oc_1", directory));

    expect(calls.some((call) => call.method === "session/resume")).toBe(false);
    expect(calls.find((call) => call.method === "session/start")?.params.approvalMode).toBe("allowAll");
    expect(binding.sessionNotices?.join("\n")).toContain("Abandoned a stuck prior turn");
    await binding.release?.();
    await manager.close();
  });
});
