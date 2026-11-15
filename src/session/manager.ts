import { createHash, randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import type { MspHandshake } from "@muse-code/sdk";
import type { RequestContext } from "../types.js";
import { MspHost } from "../msp/host.js";
import { baseServeArgs } from "../msp/contributor.js";
import {
  composeWorktreeNotices,
  countSharedSessions,
  defaultWorktreeVcs,
  findOwnWorktree,
  purgeWorktreeIfEmpty,
  type ManagedWorktree,
  type WorktreeVcs,
} from "../msp/worktree.js";
import {
  MspCommandRejectedError,
  MuseInvalidConfigError,
  MuseRecoveryChoiceRequiredError,
  MuseUnsupportedInputError,
  MuseUnsupportedRequestError,
  RegistryWorkspaceMismatchError,
  WorkspaceBusyError,
} from "../errors.js";
import { SessionRegistry } from "./registry.js";
import type { PendingCommandRecord, SessionRegistryEntry, TurnAnchor } from "./registry.js";
import type { ToolBackend } from "../msp/tool-backend.js";
import { sweepHostConfigs, userMuseConfigDir, writeHostConfig } from "../msp/host-config.js";
import { LoopbackMcpServer, type ParkedCall } from "../mcp/loopback.js";
import type { LockLease, WorkspaceLock } from "./workspace-lock.js";
import type { MuseTurnSession } from "../model/language-model.js";
import type { AgentContextResult } from "../model/agent-context.js";

export interface MuseSessionHost extends Pick<MspHost, "command" | "request" | "subscribe" | "mintCommandId" | "close"> {
  initializeResult: Record<string, unknown>;
}


const STALE_HOST_CONFIG_MS = 24 * 60 * 60 * 1000;


function rethrowMissingSessionMcp(error: unknown, backendConfig: Record<string, unknown> | undefined): void {
  if (backendConfig && error instanceof MspCommandRejectedError && error.mspKind === "capabilityRequired") {
    throw new MuseInvalidConfigError(
      "The opencode tool backend requires the sessionMcp capability, but the Muse host did not grant it (session/start or session/resume was rejected as capabilityRequired). The muse backend is unaffected.",
    );
  }
}

export interface MuseSessionManagerOptions {
  stateDirectory?: string;
  registry: SessionRegistry;
  workspaceLock: WorkspaceLock;
  museBin?: string;
  
  
  toolBackend?: ToolBackend;
  createHost?(options: { museBin?: string; cwd: string; args: readonly string[]; env?: NodeJS.ProcessEnv; capabilities?: Parameters<MspHandshake["initialize"]>[0]["capabilities"] }): Promise<MuseSessionHost>;
  videoChunkBytes?: number;
  
  worktreeVcs?: WorktreeVcs;
}

interface ManagedBinding extends Omit<MuseTurnSession, "host"> {
  host: MuseSessionHost;
  workspaceFingerprint: string;
  museSessionId: string;
  toolBackend: ToolBackend;
  
  loopback?: LoopbackMcpServer;
  hostId: string;
  viewCursor?: string;
  transcriptFingerprints: string[];
  compactionFingerprints: string[];
  pendingCommands: Record<string, PendingCommandRecord>;
  turnAnchors: TurnAnchor[];
  
  pendingAnchorTurnId?: string;
  activeTurnId?: string;
  currentSelection: { providerId: string; modelId: string; profileId: string | null };
  lease?: LockLease;
}

function canonicalWorkspacePath(directory: string): string {
  const absolute = resolve(directory);
  return existsSync(absolute) ? realpathSync(absolute) : absolute;
}

export function workspaceFingerprint(directory: string): string {
  return createHash("sha256").update(canonicalWorkspacePath(directory)).digest("hex");
}

function sessionIdFrom(result: Record<string, unknown>): string | undefined {
  const session = result.session as { sessionId?: unknown } | undefined;
  return typeof session?.sessionId === "string" ? session.sessionId : undefined;
}

function cursorFrom(result: Record<string, unknown>): string | undefined {
  return typeof result.viewCursor === "string" ? result.viewCursor : undefined;
}

function modelSelection(context: RequestContext): { providerId: string; modelId: string; profileId: string | null } {
  return {
    providerId: context.museSelection.providerId,
    modelId: context.museSelection.modelId,
    profileId: context.museSelection.profileId,
  };
}

function selectionMatches(
  entry: Pick<SessionRegistryEntry, "providerId" | "modelId" | "profileId">,
  selected: { providerId: string; modelId: string; profileId: string | null },
): boolean {
  return entry.providerId === selected.providerId
    && entry.modelId === selected.modelId
    && (entry.profileId ?? null) === selected.profileId;
}

export class MuseSessionManager {
  private readonly bindings = new Map<string, ManagedBinding>();
  private readonly contextBySession = new Map<string, AgentContextResult>();
  private readonly toolBackend: ToolBackend;
  private readonly createHost: NonNullable<MuseSessionManagerOptions["createHost"]>;
  private readonly worktreeVcs: WorktreeVcs;
  private closed = false;

  constructor(private readonly options: MuseSessionManagerOptions) {
    this.toolBackend = options.toolBackend ?? "muse";
    this.worktreeVcs = options.worktreeVcs ?? defaultWorktreeVcs;
    this.createHost = options.createHost ?? (async ({ museBin, cwd, args, env, capabilities }) => MspHost.start({
      museBin,
      cwd,
      args,
      env,
      capabilities,
      startupTimeoutMs: 20_000,
      commandTimeoutMs: 30_000,
      requestTimeoutMs: 20_000,
    }) as Promise<MuseSessionHost>);
  }

  setContextForSession(openCodeSessionId: string, context: AgentContextResult): void {
    this.contextBySession.set(openCodeSessionId, {
      supported: context.supported,
      fragments: context.fragments.map((fragment) => ({ ...fragment })),
    });
    const binding = this.bindings.get(openCodeSessionId);
    if (binding) {
      binding.contextAllowlist = context.supported ? context.fragments.map((fragment) => ({ ...fragment })) : [];
      binding.contextError = context.supported ? undefined : "agent-instructions-unrepresentable";
    }
  }

  async resolveSession(
    context: RequestContext,
    options?: { incomingFingerprints?: readonly string[] },
  ): Promise<MuseTurnSession> {
    if (this.closed) throw new MuseUnsupportedRequestError("plugin-closed");
    if (context.kind !== "primary") throw new MuseUnsupportedRequestError(context.kind);
    const canonicalDirectory = canonicalWorkspacePath(context.directory);
    const fingerprint = workspaceFingerprint(canonicalDirectory);
    const selected = modelSelection(context);
    const existingBinding = this.bindings.get(context.sessionID);
    if (existingBinding && existingBinding.workspaceFingerprint !== fingerprint) {
      throw new RegistryWorkspaceMismatchError();
    }

    
    
    
    
    
    
    
    if (existingBinding) {
      existingBinding.steerExpectedTurnId = existingBinding.activeTurnId;
      
      
      
      if (existingBinding.activeTurnId !== undefined) {
        existingBinding.streamEpoch = (existingBinding.streamEpoch ?? 0) + 1;
      }
    }

    
    
    
    
    const liveLease = existingBinding?.lease;
    const lease = liveLease ?? await this.options.workspaceLock.acquire(fingerprint, context.sessionID);
    const freshLease = liveLease === undefined;
    let host: MuseSessionHost | undefined;
    let ownedLoopback: LoopbackMcpServer | undefined;
    const sessionNotices: string[] = [];
    try {
      let stored = await this.options.registry.get(context.sessionID, fingerprint);
      const poisoned = stored !== undefined
        && (Object.keys(stored.pendingCommands).length > 0 || stored.activeTurnId !== undefined);
      if (stored && poisoned && existingBinding === undefined) {
        await this.options.registry.deleteEntry(context.sessionID, fingerprint);
        sessionNotices.push("Abandoned a stuck prior turn with an unknown outcome and started fresh; if that turn ran elsewhere, its effects still apply.");
        stored = undefined;
      }

      if (existingBinding) {
        existingBinding.lease = lease;
        try {
          await this.applySelectionIfChanged(existingBinding, selected);
          await this.persistBinding(context.sessionID, existingBinding);
        } catch (error) {
          if (freshLease) {
            existingBinding.lease = undefined;
            await lease.release();
          }
          throw error;
        }
        return existingBinding;
      }

      
      
      
      
      let backendEnv: NodeJS.ProcessEnv | undefined;
      let loopback: LoopbackMcpServer | undefined;
      if (this.toolBackend === "opencode") {
        const stateDirectory = this.options.stateDirectory ?? SessionRegistry.resolveStateDirectory();
        sweepHostConfigs(stateDirectory, STALE_HOST_CONFIG_MS, Date.now(), new Set(this.bindings.keys()));
        const hostXdg = writeHostConfig(stateDirectory, context.sessionID, { authSourceDir: userMuseConfigDir() });
        backendEnv = { ...process.env, XDG_CONFIG_HOME: hostXdg };
        
        
        
        
        const created = new LoopbackMcpServer({ sessionKey: context.sessionID, tools: [] });
        await created.listen();
        loopback = created;
        ownedLoopback = created;
      }

      host = await this.createHost({
        museBin: this.options.museBin,
        cwd: canonicalDirectory,
        args: baseServeArgs(stored?.providerId ?? selected.providerId),
        env: backendEnv,
        capabilities: {
          userInputDialogs: false,
          experimentalApi: true,
          
          
          
          
          ...(this.toolBackend === "opencode" ? { requestedCapabilities: ["sessionMcp"] } : {}),
        },
      });
      const durability = host.initializeResult.sessionDurability;
      if (stored && durability === "ephemeral") throw new MuseRecoveryChoiceRequiredError();

      const experimentalWorktrees = host.initializeResult.experimentalApi === true;
      let museSessionId: string | undefined;
      let viewCursor: string | undefined;
      let replayAfterCursor: string | undefined;
      let adoptedAnchors: TurnAnchor[] | undefined;
      let adoptedPrevious: readonly string[] | undefined;
      let worktree: ManagedWorktree | undefined;
      
      
      
      let adoptedFork = false;
      if (!stored) {
        
        
        
        
        
        const incoming = options?.incomingFingerprints;
        const adoption = await this.findForkAdoption(fingerprint, incoming);
        if (adoption && incoming) {
          const forked = await this.forkViaHost(host, adoption.sourceMuseSessionId, adoption.cutTurnId);
          if (forked) {
            museSessionId = forked.sessionId;
            viewCursor = forked.viewCursor;
            adoptedAnchors = [];
            adoptedPrevious = [...incoming];
            adoptedFork = true;
          }
        }
      }
      const backendConfig = this.toolBackend === "opencode" && loopback ? this.backendSessionConfig(loopback) : undefined;
      if (!adoptedFork && stored && durability !== "ephemeral") {
        const resumed = await host.command("session/resume", {
          commandId: host.mintCommandId(),
          sessionId: stored.museSessionId,
          ...(stored.viewCursor ? { cursor: stored.viewCursor } : {}),
          
          
          ...(backendConfig ? { config: backendConfig } : {}),
        }).catch((error: unknown) => {
          rethrowMissingSessionMcp(error, backendConfig);
          throw error;
        });
        const resumedSession = resumed.session as { activeTurnId?: unknown } | undefined;
        if (!resumedSession || !Object.hasOwn(resumedSession, "activeTurnId") || resumedSession.activeTurnId !== null) {
          throw new MuseRecoveryChoiceRequiredError();
        }
        museSessionId = sessionIdFrom(resumed) ?? stored.museSessionId;
        viewCursor = cursorFrom(resumed);
        
        
        if (experimentalWorktrees) {
          
          
          try {
            const listed = await host.request("worktree/list", { workspaceRoot: canonicalDirectory });
            const own = findOwnWorktree(listed, museSessionId);
            if (own?.path) {
              worktree = { path: own.path, branch: own.branch };
              sessionNotices.push(...composeWorktreeNotices({ workspaceRoot: canonicalDirectory, worktree: own }));
            }
          } catch {
            
          }
        }
      } else if (!adoptedFork) {
        
        
        
        
        
        
        
        
        
        const startParams = {
          commandId: host.mintCommandId(),
          workspaceRoot: canonicalDirectory,
          providerId: selected.providerId,
          modelId: selected.modelId,
          approvalMode: "allowAll",
          ...(backendConfig ? { config: backendConfig } : {}),
        };
        let start: Record<string, unknown>;
        let worktreeAttempted = false;
        let worktreeFallback = false;
        if (experimentalWorktrees) {
          worktreeAttempted = true;
          try {
            start = await host.command("session/start", { ...startParams, worktree: { mode: "create" } });
          } catch (error) {
            
            
            
            rethrowMissingSessionMcp(error, backendConfig);
            
            
            
            
            
            
            
            
            if (!(error instanceof MspCommandRejectedError)) throw error;
            
            
            start = await host.command("session/start", { ...startParams, commandId: host.mintCommandId() });
            worktreeFallback = true;
            sessionNotices.push(
              ...composeWorktreeNotices({
                workspaceRoot: canonicalDirectory,
                fallbackReason: error.mspKind,
              }),
            );
          }
        } else {
          start = await host.command("session/start", startParams).catch((error: unknown) => {
            rethrowMissingSessionMcp(error, backendConfig);
            throw error;
          });
        }
        const startedSessionId = sessionIdFrom(start);
        if (!startedSessionId) throw new MuseRecoveryChoiceRequiredError();
        museSessionId = startedSessionId;
        viewCursor = cursorFrom(start);
        if (worktreeAttempted && !worktreeFallback) {
          
          
          
          try {
            const listed = await host.request("worktree/list", { workspaceRoot: canonicalDirectory });
            const own = findOwnWorktree(listed, museSessionId);
            const sharedOthers = countSharedSessions(listed, canonicalDirectory, museSessionId);
            const baseSha = await this.worktreeVcs.baseCommit(canonicalDirectory);
            if (own?.path) worktree = { path: own.path, branch: own.branch, baseSha };
            sessionNotices.push(
              ...composeWorktreeNotices({
                workspaceRoot: canonicalDirectory,
                worktree: own,
                sharedOthers,
              }),
            );
          } catch {
            sessionNotices.push(
              `[Muse session workspace: worktree verification unavailable; merging back through normal source control.]`,
            );
          }
        }
      }

      
      
      if (museSessionId === undefined) throw new MuseRecoveryChoiceRequiredError();
      const initialSelection = stored
        ? { providerId: stored.providerId ?? selected.providerId, modelId: stored.modelId ?? selected.modelId, profileId: stored.profileId ?? null }
        : { providerId: selected.providerId, modelId: selected.modelId, profileId: null };
      const sessionContext = this.contextBySession.get(context.sessionID);
      if (this.toolBackend === "opencode") {
        sessionNotices.push("Opencode tools backend: this Muse session runs host-provided tools through the loopback bridge; OpenCode permissions apply.");
      }
      const binding: ManagedBinding = {
        host,
        sessionId: museSessionId,
        museSessionId,
        toolBackend: this.toolBackend,
        loopback,
        hostId: randomUUID(),
        workspaceFingerprint: fingerprint,
        viewCursor,
        replayAfterCursor,
        worktree,
        sessionNotices,
        streamEpoch: 0,
        currentSelection: initialSelection,
        previousTranscriptFingerprints: adoptedPrevious ? [...adoptedPrevious] : stored?.transcriptFingerprints ?? [],
        transcriptFingerprints: adoptedPrevious ? [...adoptedPrevious] : stored?.transcriptFingerprints ?? [],
        compactionFingerprints: stored?.compactionFingerprints ?? [],
        pendingCommands: stored?.pendingCommands ?? {},
        turnAnchors: adoptedAnchors ? [...adoptedAnchors] : stored?.turnAnchors ? [...stored.turnAnchors] : [],
        contextAllowlist: sessionContext?.supported ? sessionContext.fragments.map((fragment) => ({ ...fragment })) : [],
        contextError: sessionContext?.supported ? undefined : "agent-instructions-unrepresentable",
        lease,
        async recordPendingCommand(input) {
          binding.pendingCommands[input.commandId] = { method: input.method, fingerprint: input.fingerprint };
          await managerOptions.registry.recordPendingCommand(context.sessionID, fingerprint, input);
        },
        async clearPendingCommand(commandId) {
          await managerOptions.registry.clearPendingCommand(context.sessionID, fingerprint, commandId);
          delete binding.pendingCommands[commandId];
        },
        async recordTurnAccepted(_commandId, turnId) {
          const previous = binding.activeTurnId;
          const previousAnchor = binding.pendingAnchorTurnId;
          binding.activeTurnId = turnId;
          binding.pendingAnchorTurnId = turnId;
          try { await persist(); } catch (error) {
            binding.activeTurnId = previous;
            binding.pendingAnchorTurnId = previousAnchor;
            throw error;
          }
        },
        async updateCursor(cursor) {
          const previous = binding.viewCursor;
          binding.viewCursor = cursor;
          try {
            await managerOptions.registry.updateCursor(context.sessionID, fingerprint, cursor);
          } catch {
            
            
            
            binding.viewCursor = previous;
          }
        },
        async recordTurnCompleted(_turnId, _terminal) {
          const previousActive = binding.activeTurnId;
          const previousPending = binding.pendingCommands;
          const previousAnchor = binding.pendingAnchorTurnId;
          binding.activeTurnId = undefined;
          binding.replayAfterCursor = undefined;
          binding.pendingCommands = {};
          if (_terminal !== "completed") binding.pendingAnchorTurnId = undefined;
          try { await persist(); } catch (error) {
            binding.activeTurnId = previousActive;
            binding.pendingCommands = previousPending;
            binding.pendingAnchorTurnId = previousAnchor;
            throw error;
          }
        },
        async release() {
          const currentLease = binding.lease;
          binding.lease = undefined;
          await currentLease?.release();
        },
        takeParkedToolCall() {
          return binding.loopback?.takeParked();
        },
        watchParkedToolCall() {
          const loopback = binding.loopback;
          if (!loopback) {
            let cancel = () => {};
            const wait = new Promise<ParkedCall>(() => {});
            return { wait, cancel };
          }
          return loopback.watchParked();
        },
        hasParkedToolCall(toolCallId) {
          return binding.loopback?.has(toolCallId) ?? false;
        },
        resolveParkedToolCall(toolCallId, resultText) {
          const loopback = binding.loopback;
          if (!loopback) return "unknown";
          if (loopback.resolve(toolCallId, { text: resultText })) return "resolved";
          return loopback.wasResolved(toolCallId) ? "already-resolved" : "unknown";
        },
        syncLoopbackTools(tools) {
          const loopback = binding.loopback;
          if (!loopback) return;
          const converted: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> = [];
          for (const tool of tools) {
            if (typeof tool !== "object" || tool === null) continue;
            const candidate = tool as { name?: unknown; description?: unknown; inputSchema?: unknown };
            if (typeof candidate.name !== "string" || candidate.name.length === 0) continue;
            if (Array.isArray(candidate.inputSchema)) continue;
            converted.push({
              name: candidate.name,
              description: typeof candidate.description === "string" ? candidate.description : "",
              inputSchema: typeof candidate.inputSchema === "object" && candidate.inputSchema !== null
                ? candidate.inputSchema as Record<string, unknown>
                : { type: "object" },
            });
          }
          
          
          
          if (tools.length > 0 && converted.length === 0) throw new MuseUnsupportedInputError("tools");
          loopback.setTools(converted);
        },
        async commitTranscriptFingerprints(fingerprints) {
          const previousTranscript = binding.transcriptFingerprints;
          const previousFingerprints = binding.previousTranscriptFingerprints;
          const previousCompactions = binding.compactionFingerprints;
          const previousAnchors = binding.turnAnchors;
          const anchorTurnId = binding.pendingAnchorTurnId;
          binding.transcriptFingerprints = [...fingerprints];
          binding.previousTranscriptFingerprints = [...fingerprints];
          binding.compactionFingerprints = [];
          if (anchorTurnId !== undefined) {
            binding.pendingAnchorTurnId = undefined;
            const isExtension = previousTranscript.length <= fingerprints.length
              && previousTranscript.every((value, index) => fingerprints[index] === value);
            if (isExtension) {
              const last = binding.turnAnchors[binding.turnAnchors.length - 1];
              binding.turnAnchors = last?.sequenceLength === fingerprints.length
                ? [...binding.turnAnchors.slice(0, -1), { sequenceLength: fingerprints.length, turnId: anchorTurnId }]
                : [...binding.turnAnchors, { sequenceLength: fingerprints.length, turnId: anchorTurnId }];
            } else {
              
              
              binding.turnAnchors = [{ sequenceLength: fingerprints.length, turnId: anchorTurnId }];
            }
          }
          try { await persist(); } catch (error) {
            binding.transcriptFingerprints = [...previousTranscript];
            binding.previousTranscriptFingerprints = [...previousFingerprints];
            binding.compactionFingerprints = [...previousCompactions];
            binding.turnAnchors = previousAnchors;
            binding.pendingAnchorTurnId = anchorTurnId;
            throw error;
          }
        },
      };
      const managerOptions = this.options;
      const persist = async () => {
        await this.persistBinding(context.sessionID, binding);
      };

      this.bindingSessionIDs.set(binding, context.sessionID);
      this.bindings.set(context.sessionID, binding);
      await persist();
      await this.applySelectionIfChanged(binding, selected, stored);
      await persist();
      return binding;
    } catch (error) {
      await lease.release();
      if (host) await host.close().catch(() => {});
      if (ownedLoopback) await ownedLoopback.close().catch(() => {});
      throw error;
    }
  }

  
  private backendSessionConfig(loopback: LoopbackMcpServer): Record<string, unknown> {
    return {
      mcpServers: {
        
        
        
        "opencode_loopback": {
          transport: "streamableHttp",
          url: loopback.url,
          headers: { Authorization: `Bearer ${loopback.token}` },
          mode: "required",
        },
      },
    };
  }

  
  async forkSessionAtBoundary(openCodeSessionId: string, retainedLength: number): Promise<{ forked: true } | { forked: false }> {
    const binding = this.bindings.get(openCodeSessionId);
    if (!binding) return { forked: false };
    if (binding.activeTurnId !== undefined) return { forked: false };
    const unrelatedPending = Object.values(binding.pendingCommands).some((command) => command.method !== "session/fork");
    if (unrelatedPending) return { forked: false };
    if (retainedLength < 1 || retainedLength >= binding.transcriptFingerprints.length) return { forked: false };
    const cuts = binding.turnAnchors.filter((anchor) => anchor.sequenceLength === retainedLength);
    if (cuts.length !== 1) return { forked: false };
    const forked = await this.forkViaBinding(binding, cuts[0]!.turnId);
    if (!forked) return { forked: false };
    
    
    
    
    const previous = {
      sessionId: binding.sessionId,
      museSessionId: binding.museSessionId,
      viewCursor: binding.viewCursor,
      replayAfterCursor: binding.replayAfterCursor,
      handoffTakeovers: binding.handoffTakeovers,
      turnAnchors: binding.turnAnchors,
      transcriptFingerprints: binding.transcriptFingerprints,
      previousTranscriptFingerprints: binding.previousTranscriptFingerprints,
    };
    const retained = previous.transcriptFingerprints.slice(0, retainedLength);
    binding.sessionId = forked.sessionId;
    binding.museSessionId = forked.sessionId;
    binding.viewCursor = forked.viewCursor;
    binding.replayAfterCursor = undefined;
    binding.handoffTakeovers = 0;
    binding.turnAnchors = [];
    binding.transcriptFingerprints = retained;
    binding.previousTranscriptFingerprints = [...retained];
    try {
      await this.persistBinding(openCodeSessionId, binding);
    } catch (error) {
      binding.sessionId = previous.sessionId;
      binding.museSessionId = previous.museSessionId;
      binding.viewCursor = previous.viewCursor;
      binding.replayAfterCursor = previous.replayAfterCursor;
      binding.handoffTakeovers = previous.handoffTakeovers;
      binding.turnAnchors = previous.turnAnchors;
      binding.transcriptFingerprints = previous.transcriptFingerprints;
      binding.previousTranscriptFingerprints = previous.previousTranscriptFingerprints;
      throw error;
    }
    return { forked: true };
  }

  private async forkViaBinding(binding: ManagedBinding, cutTurnId: string | undefined):
    Promise<{ sessionId: string; viewCursor?: string } | undefined> {
    const fingerprint = createHash("sha256")
      .update(JSON.stringify({ method: "session/fork", sessionId: binding.museSessionId, cutTurnId: cutTurnId ?? null }))
      .digest("hex");
    const pending = Object.entries(binding.pendingCommands)
      .find(([, command]) => command.method === "session/fork" && command.fingerprint === fingerprint);
    const commandId = pending?.[0] ?? binding.host.mintCommandId();
    
    
    
    if (!pending) await binding.recordPendingCommand?.({ commandId, method: "session/fork", fingerprint });
    let result: Record<string, unknown>;
    try {
      const params: { commandId: string; sessionId: string; cutPoint?: { lastTurnId: string } } =
        { commandId, sessionId: binding.museSessionId };
      if (cutTurnId !== undefined) params.cutPoint = { lastTurnId: cutTurnId };
      result = await binding.host.command("session/fork", params) as Record<string, unknown>;
    } catch {
      return undefined;
    }
    const sessionId = sessionIdFrom(result);
    if (!sessionId) return undefined;
    try {
      await binding.clearPendingCommand?.(commandId);
    } catch {
      
      
      return undefined;
    }
    return { sessionId, viewCursor: cursorFrom(result) };
  }

  private async forkViaHost(host: MuseSessionHost, sourceMuseSessionId: string, cutTurnId: string | undefined):
    Promise<{ sessionId: string; viewCursor?: string } | undefined> {
    let result: Record<string, unknown>;
    try {
      const params: { commandId: string; sessionId: string; cutPoint?: { lastTurnId: string } } =
        { commandId: host.mintCommandId(), sessionId: sourceMuseSessionId };
      if (cutTurnId !== undefined) params.cutPoint = { lastTurnId: cutTurnId };
      result = await host.command("session/fork", params) as Record<string, unknown>;
    } catch {
      return undefined;
    }
    const sessionId = sessionIdFrom(result);
    if (!sessionId) return undefined;
    return { sessionId, viewCursor: cursorFrom(result) };
  }

  
  private async findForkAdoption(workspaceFingerprintValue: string, incoming: readonly string[] | undefined):
    Promise<{ sourceMuseSessionId: string; cutTurnId?: string } | undefined> {
    if (!incoming || incoming.length === 0) return undefined;
    const entries = await this.options.registry.list();
    const matches = entries.filter((entry) =>
      entry.workspaceFingerprint === workspaceFingerprintValue
      && entry.transcriptFingerprints.length >= incoming.length
      && incoming.every((value, index) => entry.transcriptFingerprints[index] === value));
    if (matches.length !== 1) return undefined;
    const source = matches[0]!;
    if (incoming.length === source.transcriptFingerprints.length) {
      return { sourceMuseSessionId: source.museSessionId };
    }
    const cuts = source.turnAnchors.filter((anchor) => anchor.sequenceLength === incoming.length);
    if (cuts.length !== 1) return undefined;
    return {
      sourceMuseSessionId: source.museSessionId,
      cutTurnId: cuts[0]!.turnId,
    };
  }

  
  previousTranscriptFingerprints(openCodeSessionId: string): readonly string[] | undefined {
    return this.bindings.get(openCodeSessionId)?.previousTranscriptFingerprints;
  }

  
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const bindings = [...this.bindings.values()];
    this.bindings.clear();
    
    
    await Promise.all(bindings.map((binding) => purgeWorktreeIfEmpty(this.worktreeVcs, binding.worktree)));
    await Promise.all(bindings.map(async (binding) => {
      try {
        await binding.host.close?.();
      } catch {
        
        
      } finally {
        await binding.loopback?.close().catch(() => {});
        await binding.release?.().catch(() => {});
      }
    }));
  }

  async recordCompactionCandidate(openCodeSessionId: string, fingerprint: string): Promise<void> {
    const binding = this.bindings.get(openCodeSessionId);
    if (binding) {
      const lease = await this.options.workspaceLock.acquire(binding.workspaceFingerprint, openCodeSessionId);
      try {
        binding.compactionFingerprints = [fingerprint];
        await this.persistBinding(openCodeSessionId, binding);
      } finally {
        await lease.release();
      }
      return;
    }
    const stored = await this.options.registry.getForOpenCodeSession(openCodeSessionId);
    if (!stored) return;
    const lease = await this.options.workspaceLock.acquire(stored.workspaceFingerprint, openCodeSessionId);
    try {
      await this.options.registry.recordCompactionCandidate(openCodeSessionId, fingerprint);
    } finally {
      await lease.release();
    }
  }

  private async applySelectionIfChanged(
    binding: ManagedBinding,
    selected: { providerId: string; modelId: string; profileId: string | null },
    stored?: Pick<SessionRegistryEntry, "providerId" | "modelId" | "profileId">,
  ): Promise<void> {
    const currentMatches = stored
      ? selectionMatches(stored, selected)
      : binding.currentSelection.providerId === selected.providerId
        && binding.currentSelection.modelId === selected.modelId
        && binding.currentSelection.profileId === selected.profileId;
    if (currentMatches) {
      binding.currentSelection = selected;
      return;
    }
    const commandId = binding.host.mintCommandId();
    const method = "session/setModel";
    const params = {
      commandId,
      sessionId: binding.sessionId,
      model: selected,
    };
    const commandFingerprint = createHash("sha256").update(JSON.stringify({ method, params })).digest("hex");
    const openCodeSessionId = this.openCodeSessionIdFor(binding);
    const pending = { method, fingerprint: commandFingerprint };
    binding.pendingCommands[commandId] = pending;
    try {
      await this.options.registry.recordPendingCommand(openCodeSessionId, binding.workspaceFingerprint, {
        commandId,
        ...pending,
      });
    } catch (error) {
      delete binding.pendingCommands[commandId];
      throw error;
    }
    try {
      await binding.host.command(method, params);
    } catch (error) {
      if (error instanceof MspCommandRejectedError) {
        await this.options.registry.clearPendingCommand(openCodeSessionId, binding.workspaceFingerprint, commandId);
        delete binding.pendingCommands[commandId];
      }
      throw error;
    }
    await this.options.registry.clearPendingCommand(openCodeSessionId, binding.workspaceFingerprint, commandId);
    delete binding.pendingCommands[commandId];
    binding.currentSelection = selected;
    await this.persistBinding(openCodeSessionId, binding);
  }

  private readonly bindingSessionIDs = new WeakMap<ManagedBinding, string>();

  private openCodeSessionIdFor(binding: ManagedBinding): string {
    const sessionId = this.bindingSessionIDs.get(binding);
    if (!sessionId) throw new MuseRecoveryChoiceRequiredError();
    return sessionId;
  }

  private async persistBinding(openCodeSessionId: string, binding: ManagedBinding): Promise<void> {
    await this.options.registry.put({
      openCodeSessionId,
      museSessionId: binding.museSessionId,
      hostId: binding.hostId,
      workspaceFingerprint: binding.workspaceFingerprint,
      providerId: binding.currentSelection.providerId,
      ...(binding.currentSelection.profileId !== null ? { profileId: binding.currentSelection.profileId } : {}),
      modelId: binding.currentSelection.modelId,
      ...(binding.viewCursor ? { viewCursor: binding.viewCursor } : {}),
      ...(binding.activeTurnId ? { activeTurnId: binding.activeTurnId } : {}),
      transcriptFingerprints: binding.transcriptFingerprints,
      compactionFingerprints: binding.compactionFingerprints,
      pendingCommands: binding.pendingCommands,
      turnAnchors: binding.turnAnchors,
    });
  }
}
