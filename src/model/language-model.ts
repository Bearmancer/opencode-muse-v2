import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3StreamPart,
} from "@ai-sdk/provider";
import { createHash } from "node:crypto";
import { MspCommandRejectedError, MuseBridgeError, MuseRecoveryChoiceRequiredError, MuseTranscriptDivergedError, MuseUnsupportedInputError, MuseUnsupportedRequestError, MspProtocolError, MspTransportError } from "../errors.js";
import type { MspNotification } from "../msp/client.js";
import type { ToolBackend } from "../msp/tool-backend.js";
import type { ParkedCall } from "../mcp/loopback.js";
import { notificationCursorKey } from "../msp/notification.js";
import { MUSE_CONTEXT_HEADERS, readRequestContext } from "./context.js";
import { classifyMetaRequest, makeCompactionDigest, makeLocalTitle, type MetaRequestClass } from "./meta.js";
import { promptContainsCompactionFingerprint } from "../session/fingerprint.js";
import {
  extractToolResults,
  extractTurnInput,
  fingerprintVisibleTranscript,
  latestUserText,
  validateModelOptions,
  type ContextFragment,
  type ExtractedTurnPart,
  type ExtractTurnInputResult,
} from "./prompt.js";
import { MuseStreamMapper, resultUsage } from "./stream.js";
import type { MuseModelSelection, RequestContext } from "../types.js";
import type { TranscribeAudio } from "../msp/transcribe.js";
import { pendingFirstTurnNotices, resolveStagingRoot } from "../msp/worktree.js";
import type { StagePdfOutcome } from "../msp/pdf.js";

export interface MuseTurnHost {
  mintCommandId(): string;
  command<TResult extends object = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> & { commandId: string },
  ): Promise<TResult>;
  request<TResult extends object = Record<string, unknown>>(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<TResult>;
  subscribe(sessionId: string, after?: string, signal?: AbortSignal): AsyncIterable<MspNotification>;
  close?(): Promise<void>;
}

export interface MuseTurnSession {
  host: MuseTurnHost;
  sessionId: string;
  previousTranscriptFingerprints: readonly string[];
  compactionFingerprints?: readonly string[];
  commitTranscriptFingerprints?(fingerprints: readonly string[]): Promise<void>;
  contextAllowlist: readonly ContextFragment[];
  contextError?: string;
  replayAfterCursor?: string;
  
  viewCursor?: string;
  currentSelection?: Pick<MuseModelSelection, "providerId" | "modelId" | "profileId">;
  recordPendingCommand?(input: { commandId: string; method: string; fingerprint: string }): Promise<void>;
  clearPendingCommand?(commandId: string): Promise<void>;
  recordTurnAccepted?(commandId: string, turnId: string): Promise<void>;
  
  activeTurnId?: string;
  
  toolBackend?: ToolBackend;
  
  attachToActiveTurn?: boolean;
  
  takeParkedToolCall?(): ParkedCall | undefined;
  
  watchParkedToolCall?(): { wait: Promise<ParkedCall>; cancel(): void };
  
  hasParkedToolCall?(toolCallId: string): boolean;
  
  resolveParkedToolCall?(toolCallId: string, resultText: string): "resolved" | "already-resolved" | "unknown";
  
  syncLoopbackTools?(tools: readonly unknown[]): void;
  updateCursor?(cursor: string): Promise<void>;
  recordTurnCompleted?(turnId: string, terminal: string, usage?: Record<string, unknown>): Promise<void>;
  release?(): Promise<void>;
  
  worktree?: { path?: string; branch?: string };
  
  sessionNotices?: string[];
  
  steerExpectedTurnId?: string;
  
  streamEpoch?: number;
  
  handoffTakeovers?: number;
}


export interface MuseLanguageRuntime {
  selectionIndex: ReadonlyMap<string, MuseModelSelection>;
  resolveSession(context: RequestContext, options?: { incomingFingerprints?: readonly string[] }): Promise<MuseTurnSession>;
  
  forkSessionAtBoundary?(sessionID: string, retainedLength: number): Promise<{ forked: true } | { forked: false }>;
  videoChunkBytes?: number;
  previousTranscriptFingerprints?(sessionID: string): readonly string[] | undefined;
  
  transcribeAudioClip?: TranscribeAudio;
  
  stagePdfAttachment?: (directory: string, bytes: Uint8Array) => Promise<StagePdfOutcome>;
}

export interface MuseTurnExecution {
  turnId: string;
  commandId: string;
  disposition: string;
  events: AsyncIterable<MspNotification>;
  cancel(): Promise<void>;
}


function userTextOf(parts: ExtractedTurnPart[]): string {
  return parts
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
}


function syntheticParkedNotification(
  session: MuseTurnSession,
  turnId: string | undefined,
  parked: ParkedCall,
): MspNotification {
  return {
    jsonrpc: "2.0",
    method: "bridge/tool-parked",
    params: {
      sessionId: session.sessionId,
      turnId,
      mcpCallId: parked.callId,
      toolName: parked.toolName,
      args: parked.args,
    },
  };
}


function commonPrefixLength(previous: readonly string[], current: readonly string[]): number {
  let length = 0;
  while (length < previous.length && length < current.length && previous[length] === current[length]) length += 1;
  return length;
}


const DEFAULT_VIDEO_CHUNK_BYTES = 6 * 1024 * 1024;

function fingerprint(method: string, params: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify({ method, params })).digest("hex");
}

function sameSelection(
  current: Pick<MuseModelSelection, "providerId" | "modelId" | "profileId"> | undefined,
  next: MuseModelSelection,
): boolean {
  return current !== undefined
    && current.providerId === next.providerId
    && current.modelId === next.modelId
    && (current.profileId ?? null) === next.profileId;
}


async function interruptParkedTurn(session: MuseTurnSession, turnId: string): Promise<void> {
  try {
    await submitCommand(session, "turn/interrupt", session.host.mintCommandId(), {
      sessionId: session.sessionId,
      turnId,
      retract: true,
    });
  } catch {
    
    
  }
}

async function submitCommand(
  session: MuseTurnSession,
  method: string,
  commandId: string,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const requestParams = { ...params, commandId };
  const requestFingerprint = fingerprint(method, requestParams);
  await session.recordPendingCommand?.({ commandId, method, fingerprint: requestFingerprint });
  try {
    const result = await session.host.command(method, requestParams);
    if (method !== "turn/start") {
      try {
        await session.clearPendingCommand?.(commandId);
      } catch {
        
        
        
        
      }
    }
    return result as Record<string, unknown>;
  } catch (error) {
    
    
    if (error instanceof MspCommandRejectedError) await session.clearPendingCommand?.(commandId);
    throw error;
  }
}

async function mapVideoParts(
  session: MuseTurnSession,
  parts: readonly ExtractedTurnPart[],
  signal?: AbortSignal,
  chunkBytes = DEFAULT_VIDEO_CHUNK_BYTES,
): Promise<Array<Record<string, unknown>>> {
  const result: Array<Record<string, unknown>> = [];
  for (const part of parts) {
    if (part.type !== "video") {
      result.push(part);
      continue;
    }
    if (signal?.aborted) throw new DOMException("Muse request aborted before turn start", "AbortError");
    const bytes = Buffer.from(part.base64Data, "base64");
    if (bytes.byteLength !== part.totalBytes || bytes.byteLength === 0) throw new MspProtocolError("media/upload");
    const uploadId = session.host.mintCommandId();
    const chunkCount = Math.ceil(bytes.byteLength / chunkBytes);
    for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1) {
      if (signal?.aborted) throw new DOMException("Muse request aborted before turn start", "AbortError");
      const chunk = bytes.subarray(chunkIndex * chunkBytes, Math.min(bytes.byteLength, (chunkIndex + 1) * chunkBytes));
      const commandId = session.host.mintCommandId();
      const receipt = await submitCommand(session, "media/upload", commandId, {
        sessionId: session.sessionId,
        uploadId,
        mediaType: part.mediaType,
        chunkIndex,
        chunkCount,
        totalBytes: bytes.byteLength,
        chunkBase64: Buffer.from(chunk).toString("base64"),
      });
      if (receipt.uploadId !== uploadId) throw new MspProtocolError("media/upload");
    }
    result.push({ type: "video", uploadId });
  }
  return result;
}

function eventTurnId(notification: MspNotification, itemTurnIds: Map<string, string>): string | undefined {
  const params = notification.params ?? {};
  if (typeof params.turnId === "string") return params.turnId;
  const item = params.item as { itemId?: unknown; turnId?: unknown } | undefined;
  if (typeof item?.itemId === "string" && typeof item.turnId === "string") itemTurnIds.set(item.itemId, item.turnId);
  if (typeof item?.turnId === "string") return item.turnId;
  if (notification.method === "item/delta" && typeof params.itemId === "string") return itemTurnIds.get(params.itemId);
  return undefined;
}

async function* pageGapNotifications(
  host: MuseTurnHost,
  sessionId: string,
  gap: { after: string; next: string },
): AsyncIterable<MspNotification> {
  let cursor = gap.after;
  const requestedCursors = new Set<string>([gap.after]);
  const eventKeys = new Set<string>();
  for (let pageNumber = 0; pageNumber < 100; pageNumber += 1) {
    const requestCursor = cursor;
    const page = await host.request<{ events?: unknown; nextCursor?: unknown }>("view/page", {
      sessionId,
      cursor,
      direction: "forward",
      limit: 1000,
    });
    if (!Array.isArray(page.events)) throw new MspProtocolError("view/page");
    let boundaryReached = false;
    for (const event of page.events) {
      if (typeof event !== "object" || event === null) throw new MspProtocolError("view/page");
      const record = event as { method?: unknown; params?: unknown };
      const params = record.params as Record<string, unknown> | undefined;
      if (typeof record.method !== "string" || !params || params.sessionId !== sessionId || typeof params.viewCursor !== "string") {
        throw new MspProtocolError("view/page");
      }
      const atBoundary = params.viewCursor === gap.next;
      if (atBoundary) boundaryReached = true;
      cursor = params.viewCursor;
      const notification = { jsonrpc: "2.0", method: record.method, params } as MspNotification;
      const key = notificationCursorKey(notification);
      if (key && eventKeys.has(key)) throw new MspProtocolError("view/page");
      if (key) eventKeys.add(key);
      yield notification;
    }
    if (boundaryReached) return;
    if (page.nextCursor === null || typeof page.nextCursor !== "string"
      || page.nextCursor === requestCursor || requestedCursors.has(page.nextCursor)) {
      throw new MspProtocolError("view/page");
    }
    requestedCursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }
  throw new MspProtocolError("view/page");
}

export async function runMuseTurn(
  context: RequestContext,
  input: readonly ExtractedTurnPart[],
  options: Pick<LanguageModelV3CallOptions, "abortSignal">,
  runtime: MuseLanguageRuntime,
  transcriptFingerprints?: readonly string[],
): Promise<MuseTurnExecution> {
  const session = await runtime.resolveSession(context);
  let terminalSeen = false;
  let accepted = false;
  let abortRequested = options.abortSignal?.aborted ?? false;
  let cancelPromise: Promise<void> | undefined;
  let turnId: string | undefined;
  let disposition: string | undefined;
  let subscription: AsyncIterator<MspNotification> | undefined;
  let firstNotification: Promise<IteratorResult<MspNotification>> | undefined;
  let subscriptionController: AbortController | undefined;
  const attachTurn = session.attachToActiveTurn === true && session.activeTurnId !== undefined;
  session.attachToActiveTurn = undefined;
  const steerTarget = !attachTurn ? session.steerExpectedTurnId : undefined;
  session.steerExpectedTurnId = undefined;
  const steering = steerTarget !== undefined;
  if (!steering && !attachTurn) {
    session.handoffTakeovers = 0;
  } else if (attachTurn) {
    session.handoffTakeovers = Math.max(0, (session.handoffTakeovers ?? 0) - 1);
  }

  const cancel = () => {
    if (cancelPromise) return cancelPromise;
    if (!attachTurn && (session.handoffTakeovers ?? 0) > 0) return Promise.resolve();
    if (!turnId || !disposition) {
      abortRequested = true;
      return Promise.resolve();
    }
    const unqueue = disposition === "queued";
    const method = unqueue ? "turn/unqueue" : "turn/interrupt";
    const params = unqueue
      ? { sessionId: session.sessionId, turnId }
      : { sessionId: session.sessionId, turnId, retract: true };
    cancelPromise = submitCommand(session, method, session.host.mintCommandId(), params).then(() => {});
    return cancelPromise;
  };
  const onAbort = () => { abortRequested = true; void cancel().catch(() => {}); };
  options.abortSignal?.addEventListener("abort", onAbort, { once: true });

  try {
    const turnCommandId = session.host.mintCommandId();
    if (attachTurn) {
      
      
      
      turnId = session.activeTurnId!;
      disposition = "joined";
      subscriptionController = new AbortController();
      subscription = session.host.subscribe(session.sessionId, session.viewCursor, subscriptionController.signal)[Symbol.asyncIterator]();
      firstNotification = subscription.next();
      accepted = true;
    } else {
      if (!sameSelection(session.currentSelection, context.museSelection)) {
        const model: Record<string, unknown> = {
          providerId: context.museSelection.providerId,
          modelId: context.museSelection.modelId,
        };
        if (context.museSelection.profileId !== null) model.profileId = context.museSelection.profileId;
        await submitCommand(session, "session/setModel", session.host.mintCommandId(), {
          sessionId: session.sessionId,
          model,
        });
      }

      const inputParts = await mapVideoParts(session, input, options.abortSignal, runtime.videoChunkBytes);
      if (options.abortSignal?.aborted) throw new DOMException("Muse request aborted before turn start", "AbortError");
      subscriptionController = new AbortController();
      subscription = session.host.subscribe(session.sessionId, session.replayAfterCursor, subscriptionController.signal)[Symbol.asyncIterator]();
      firstNotification = subscription.next();
      
      
      
      
      
      if (steering) {
        try {
          await submitCommand(session, "turn/steer", turnCommandId, {
            sessionId: session.sessionId,
            expectedTurnId: steerTarget,
            input: inputParts,
          });
          turnId = steerTarget;
          disposition = "steered";
          accepted = true;
          session.handoffTakeovers = (session.handoffTakeovers ?? 0) + 1;
        } catch (error) {
          if (!(error instanceof MspCommandRejectedError)) throw error;
          session.handoffTakeovers = 0;
        }
      }
      if (!accepted) {
        const startCommandId = session.host.mintCommandId();
        const params: Record<string, unknown> = {
          sessionId: session.sessionId,
          input: inputParts,
        };
        if (context.effort) params.reasoningEffort = context.effort;
        const ack = await submitCommand(session, "turn/start", startCommandId, params);
        if (typeof ack.turnId !== "string" || typeof ack.disposition !== "string") {
          throw new MspProtocolError("turn/start");
        }
        turnId = ack.turnId;
        disposition = ack.disposition;
        accepted = true;
        await session.recordTurnAccepted?.(startCommandId, turnId);
      }
    }
    if (turnId === undefined || disposition === undefined) {
      throw new MspProtocolError(steering ? "turn/steer" : "turn/start");
    }
    if (abortRequested) await cancel();

    const events: AsyncIterable<MspNotification> = {
      [Symbol.asyncIterator]: async function* () {
        const itemTurnIds = new Map<string, string>();
        const seenNotifications = new Set<string>();
        let parkedBreak = false;
        const processNotification = async function* (notification: MspNotification): AsyncIterable<MspNotification> {
          const params = notification.params ?? {};
          if (params.sessionId !== session.sessionId) return;
          if (typeof params.viewCursor === "string") await session.updateCursor?.(params.viewCursor);
          const notificationTurnId = eventTurnId(notification, itemTurnIds);
          if (notificationTurnId !== turnId) return;
          yield notification;
          if (notification.method === "turn/completed" || notification.method === "turn/unqueued" || notification.method === "turn/retracted") {
            terminalSeen = true;
            const terminal = notification.method === "turn/completed" && typeof params.terminal === "string"
              ? params.terminal
              : notification.method === "turn/unqueued" ? "unqueued" : "retracted";
            await session.recordTurnCompleted?.(turnId!, terminal, params.usage as Record<string, unknown> | undefined);
            if (terminal === "completed" && transcriptFingerprints) {
              await session.commitTranscriptFingerprints?.(transcriptFingerprints);
            }
          }
        };
        try {
          let next = await firstNotification!;
          while (!next.done) {
            const notification = next.value;
            const params = notification.params ?? {};
            if (notification.method === "view/gap" && params.sessionId === session.sessionId) {
              if (typeof params.after !== "string" || typeof params.next !== "string") throw new MspProtocolError("view/gap");
              for await (const replay of pageGapNotifications(session.host, session.sessionId, { after: params.after, next: params.next })) {
                const replayKey = notificationCursorKey(replay);
                if (replayKey && seenNotifications.has(replayKey)) continue;
                if (replayKey) seenNotifications.add(replayKey);
                for await (const output of processNotification(replay)) yield output;
                if (terminalSeen) return;
              }
            } else {
              const notificationKey = notificationCursorKey(notification);
              if (notificationKey && seenNotifications.has(notificationKey)) {
                next = await subscription!.next();
                continue;
              }
              if (notificationKey) seenNotifications.add(notificationKey);
              for await (const output of processNotification(notification)) yield output;
              if (terminalSeen) return;
            }
            
            
            
            
            
            
            if (session.toolBackend === "opencode") {
              const queued = session.takeParkedToolCall?.();
              if (queued) {
                for await (const output of processNotification(syntheticParkedNotification(session, turnId, queued))) yield output;
                parkedBreak = true;
                session.handoffTakeovers = (session.handoffTakeovers ?? 0) + 1;
                break;
              }
              const watcher = session.watchParkedToolCall?.();
              if (watcher) {
                try {
                  const raced = await Promise.race([
                    subscription!.next().then((result) => ({ result })),
                    watcher.wait.then((call) => ({ call })),
                  ]);
                  if ("call" in raced) {
                    
                    
                    const taken = session.takeParkedToolCall?.() ?? raced.call;
                    for await (const output of processNotification(syntheticParkedNotification(session, turnId, taken))) yield output;
                    parkedBreak = true;
                    session.handoffTakeovers = (session.handoffTakeovers ?? 0) + 1;
                    break;
                  }
                  next = raced.result;
                  continue;
                } finally {
                  watcher.cancel();
                }
              }
            }
            next = await subscription!.next();
          }
          if (!terminalSeen && !parkedBreak) throw new MspTransportError();
        } finally {
          options.abortSignal?.removeEventListener("abort", onAbort);
          subscriptionController?.abort();
          await subscription?.return?.();
          
          
          
          
          
          
          
          if (!parkedBreak) {
            const takeovers = session.handoffTakeovers ?? 0;
            if (takeovers > 0) session.handoffTakeovers = takeovers - 1;
            else if (session.activeTurnId === undefined || session.activeTurnId === turnId) {
              await session.release?.();
            }
          }
        }
      },
    };
    return { turnId, commandId: turnCommandId, disposition, events, cancel };
  } catch (error) {
    options.abortSignal?.removeEventListener("abort", onAbort);
    if (accepted && subscription && firstNotification && turnId) {
      
      
      
      try { await cancel(); } catch {  }
      void (async () => {
        const itemTurnIds = new Map<string, string>();
        try {
          let next = await firstNotification!.catch(() => ({ done: true as const, value: undefined }));
          while (!next.done) {
            const notification = next.value;
            const params = notification.params ?? {};
            if (eventTurnId(notification, itemTurnIds) === turnId) {
              if (typeof params.viewCursor === "string") {
                await session.updateCursor?.(params.viewCursor).catch(() => {});
              }
              if (["turn/completed", "turn/unqueued", "turn/retracted"].includes(notification.method)) {
                const terminal = notification.method === "turn/completed" && typeof params.terminal === "string"
                  ? params.terminal
                  : notification.method === "turn/unqueued" ? "unqueued" : "retracted";
                await session.recordTurnCompleted?.(turnId!, terminal, params.usage as Record<string, unknown> | undefined).catch(() => {});
                if (terminal === "completed" && transcriptFingerprints) {
                  await session.commitTranscriptFingerprints?.(transcriptFingerprints).catch(() => {});
                }
                break;
              }
            }
            next = await subscription!.next();
          }
        } catch {
          
        } finally {
          subscriptionController?.abort();
          await subscription?.return?.().catch(() => {});
          const takeovers = session.handoffTakeovers ?? 0;
          if (takeovers > 0) session.handoffTakeovers = takeovers - 1;
          else if (session.activeTurnId === undefined || session.activeTurnId === turnId) {
            await session.release?.().catch(() => {});
          }
        }
      })();
    } else if (!accepted) {
      subscriptionController?.abort();
      await firstNotification?.catch(() => undefined);
      await subscription?.return?.();
      const commandMethod = (error as { method?: unknown } | null)?.method;
      const ambiguousTurnStart = commandMethod === "turn/start" && !(error instanceof MspCommandRejectedError);
      
      if (!ambiguousTurnStart) await session.release?.();
    }
    throw error;
  }
}

function contextErrorToException(error: { code: string; field: string }): MuseBridgeError {
  return new MuseBridgeError("MUSE_UNSUPPORTED_REQUEST", `Muse model request context is ${error.code} (${error.field})`, false);
}

function inputErrorToException(error: { code: string; field?: string; mediaType?: string }): Error {
  if (error.code === "transcript-diverged") return new MuseTranscriptDivergedError();
  return new MuseUnsupportedInputError(error.field ?? error.mediaType ?? error.code);
}

function ignoredOptionWarnings(ignoredOptions: readonly string[]): Array<Record<string, unknown>> {
  return ignoredOptions.map((feature) => ({
    type: "unsupported",
    feature,
    details: "Muse MSP does not expose this per-turn option; the setting was ignored.",
  }));
}

function requestKindFromHeaders(options: LanguageModelV3CallOptions): string | undefined {
  const headers = options.headers;
  if (!headers) return undefined;
  const name = MUSE_CONTEXT_HEADERS.kind.toLowerCase();
  for (const [key, value] of Object.entries(headers)) if (key.toLowerCase() === name) return value;
  return undefined;
}

function classifyCall(options: LanguageModelV3CallOptions): MetaRequestClass {
  return classifyMetaRequest(requestKindFromHeaders(options), options.prompt);
}

function localMetaText(kind: "title" | "compaction", options: LanguageModelV3CallOptions): string {
  return kind === "title"
    ? makeLocalTitle(options.prompt)
    : makeCompactionDigest(options.prompt, options.maxOutputTokens);
}

function localMetaGenerateResult(kind: "title" | "compaction", text: string): Awaited<ReturnType<LanguageModelV3["doGenerate"]>> {
  return {
    content: text ? [{ type: "text", text }] : [],
    finishReason: { unified: "stop", raw: `local-${kind}` },
    usage: resultUsage(undefined),
    warnings: [],
  } as unknown as Awaited<ReturnType<LanguageModelV3["doGenerate"]>>;
}

function localMetaStream(kind: "title" | "compaction", text: string): ReadableStream<LanguageModelV3StreamPart> {
  return new ReadableStream<LanguageModelV3StreamPart>({
    start(controller) {
      controller.enqueue({ type: "stream-start", warnings: [] } as unknown as LanguageModelV3StreamPart);
      if (text) {
        controller.enqueue({ type: "text-start", id: `local-${kind}` } as unknown as LanguageModelV3StreamPart);
        controller.enqueue({ type: "text-delta", id: `local-${kind}`, delta: text } as unknown as LanguageModelV3StreamPart);
        controller.enqueue({ type: "text-end", id: `local-${kind}` } as unknown as LanguageModelV3StreamPart);
      }
      controller.enqueue({
        type: "finish",
        finishReason: { unified: "stop", raw: `local-${kind}` },
        usage: resultUsage(undefined),
      } as unknown as LanguageModelV3StreamPart);
      controller.close();
    },
  });
}

export function createMuseLanguageModel(runtime: MuseLanguageRuntime, modelID: string): LanguageModelV3 {
  const doPrepare = async (options: LanguageModelV3CallOptions) => {
    const requestKind = classifyCall(options);
    if (requestKind !== "agent") throw new MuseUnsupportedRequestError(requestKind);
    const context = readRequestContext(options, runtime.selectionIndex);
    if ("type" in context) throw contextErrorToException(context);
    if (context.kind !== "primary") throw new MuseUnsupportedRequestError(context.kind);
    const supportedOptions = validateModelOptions(options);
    if (!supportedOptions.ok) throw inputErrorToException(supportedOptions.error);
    const initialExtraction = await extractTurnInput(options.prompt, [], [], {
      signal: options.abortSignal,
      transcribeAudio: runtime.transcribeAudioClip,
      stagePdfAttachment: runtime.stagePdfAttachment
        ? (bytes: Uint8Array) => runtime.stagePdfAttachment!(context.directory, bytes)
        : undefined,
    });
    if (!initialExtraction.ok) throw inputErrorToException(initialExtraction.error);
    const currentFingerprints = fingerprintVisibleTranscript(options.prompt);
    const session = await runtime.resolveSession(context, {
      incomingFingerprints: currentFingerprints,
    });
    if (session.toolBackend === "opencode") {
      const forwarded = (options as { tools?: unknown }).tools;
      if (Array.isArray(forwarded) && forwarded.length > 0) {
        session.syncLoopbackTools?.(forwarded);
      }
      if (session.activeTurnId !== undefined) {
        const toolResults = extractToolResults(options.prompt);
        if (toolResults.length > 0) {
          for (const toolResult of toolResults) {
            const outcome = session.resolveParkedToolCall?.(toolResult.toolCallId, toolResult.outputText) ?? "unknown";
            if (outcome === "unknown") {
              await session.release?.();
              throw new MuseUnsupportedInputError("tool-result");
            }
          }
          session.attachToActiveTurn = true;
          const execution = await runMuseTurn(context, [], options, {
            ...runtime,
            resolveSession: async () => session,
          }, currentFingerprints);
          return {
            context,
            execution,
            mapper: new MuseStreamMapper(execution.turnId),
            warnings: ignoredOptionWarnings(supportedOptions.options.ignoredOptions),
            epoch: session.streamEpoch,
            session,
          };
        }
      }
    }
    if (session.contextError) {
      await session.release?.();
      throw new MuseUnsupportedRequestError(session.contextError);
    }
    const observedCompaction = (session.compactionFingerprints ?? []).some((candidate) =>
      promptContainsCompactionFingerprint(options.prompt, candidate),
    );
    const runExtraction = () => extractTurnInput(
      options.prompt,
      observedCompaction ? [] : session.previousTranscriptFingerprints,
      session.contextAllowlist,
      {
        signal: options.abortSignal,
        transcribeAudio: runtime.transcribeAudioClip,
        stagePdfAttachment: runtime.stagePdfAttachment
          ? (bytes: Uint8Array) =>
              runtime.stagePdfAttachment!(resolveStagingRoot(session.worktree?.path, context.directory), bytes)
          : undefined,
      },
    );
    const noteFirstTurn = (result: ExtractTurnInputResult) => {
      if (!result.ok) return;
      const notices = pendingFirstTurnNotices(session.sessionNotices, session.previousTranscriptFingerprints, observedCompaction);
      if (notices.length > 0) result.parts.unshift({ type: "text", text: notices.join("\n") });
    };
    let extracted = await runExtraction();
    noteFirstTurn(extracted);
    if (!extracted.ok && extracted.error.code === "transcript-diverged" && session.activeTurnId === undefined) {
      
      
      
      
      const retained = commonPrefixLength(session.previousTranscriptFingerprints, currentFingerprints);
      const fork = await runtime.forkSessionAtBoundary?.(context.sessionID, retained) ?? { forked: false };
      if (fork.forked) {
        extracted = await runExtraction();
        noteFirstTurn(extracted);
      }
    }
    if (!extracted.ok) {
      await session.release?.();
      throw inputErrorToException(extracted.error);
    }
    const execution = await runMuseTurn(context, extracted.parts, options, {
      ...runtime,
      resolveSession: async () => session,
    }, extracted.nextTranscriptFingerprints);
    return {
      context,
      execution,
      mapper: new MuseStreamMapper(execution.turnId),
      warnings: ignoredOptionWarnings(supportedOptions.options.ignoredOptions),
      epoch: session.streamEpoch,
      session,
    };
  };

  return {
    specificationVersion: "v3",
    
    
    specVersion: "v3",
    provider: "muse",
    modelId: modelID,
    supportedUrls: {},
    async doStream(options: LanguageModelV3CallOptions) {
      const requestKind = classifyCall(options);
      if (requestKind === "title" || requestKind === "compaction") {
        return { stream: localMetaStream(requestKind, localMetaText(requestKind, options)) };
      }
      if (requestKind === "unsupported-generate") throw new MuseUnsupportedRequestError("generate");
      const prepared = await doPrepare(options);
      let outputClosed = false;
      let controllerRef: ReadableStreamDefaultController<LanguageModelV3StreamPart> | undefined;
      const closeOutput = () => {
        if (outputClosed) return;
        outputClosed = true;
        try { controllerRef?.close(); } catch {  }
      };
      const stream = new ReadableStream<LanguageModelV3StreamPart>({
        start(controller) {
          controllerRef = controller;
          controller.enqueue({ type: "stream-start", warnings: prepared.warnings } as unknown as LanguageModelV3StreamPart);
          void (async () => {
            try {
              for await (const notification of prepared.execution.events) {
                
                
                
                if (prepared.epoch !== undefined && prepared.session.streamEpoch !== undefined
                  && prepared.session.streamEpoch !== prepared.epoch) {
                  closeOutput();
                  break;
                }
                const parts = prepared.mapper.accept(notification);
                for (const part of parts) {
                  if (outputClosed) continue;
                  if (part.type === "finish") {
                    controller.enqueue(part as unknown as LanguageModelV3StreamPart);
                    closeOutput();
                    continue;
                  }
                  controller.enqueue(part as unknown as LanguageModelV3StreamPart);
                }
              }
              if (!outputClosed) closeOutput();
            } catch (error) {
              if (outputClosed) return;
              const safeError = error instanceof MuseBridgeError ? error : new MspTransportError();
              controller.enqueue({ type: "error", error: safeError } as unknown as LanguageModelV3StreamPart);
              controller.enqueue({
                type: "finish",
                finishReason: { unified: "error", raw: undefined },
                usage: resultUsage(prepared.mapper.usage),
              } as unknown as LanguageModelV3StreamPart);
              closeOutput();
            }
          })();
        },
        async cancel() {
          outputClosed = true;
          await prepared.execution.cancel();
        },
      });
      return { stream };
    },
    async doGenerate(options: LanguageModelV3CallOptions) {
      const requestKind = classifyCall(options);
      if (requestKind === "title" || requestKind === "compaction") {
        return localMetaGenerateResult(requestKind, localMetaText(requestKind, options));
      }
      if (requestKind === "unsupported-generate") throw new MuseUnsupportedRequestError("generate");
      const prepared = await doPrepare(options);
      let terminalError: Error | undefined;
      const iterator = prepared.execution.events[Symbol.asyncIterator]();
      while (true) {
        if (prepared.epoch !== undefined && prepared.session.streamEpoch !== undefined
          && prepared.session.streamEpoch !== prepared.epoch) {
          break;
        }
        const next = await iterator.next();
        if (next.done) break;
        const parts = prepared.mapper.accept(next.value);
        if (prepared.mapper.failure) terminalError = prepared.mapper.failure;
        const foregroundFinished = parts.some((part) =>
          part.type === "finish"
          && (part.finishReason as { raw?: unknown } | undefined)?.raw === "foregroundCompleted",
        );
        if (foregroundFinished) {
          void (async () => {
            try {
              while (!(await iterator.next()).done) {
                
              }
            } catch {
              
              
            }
          })();
          break;
        }
      }
      if (terminalError) throw terminalError;
      return {
        content: prepared.mapper.content,
        finishReason: prepared.mapper.finishReason ?? { unified: "other", raw: undefined },
        usage: resultUsage(prepared.mapper.usage),
        warnings: prepared.warnings,
      } as unknown as Awaited<ReturnType<LanguageModelV3["doGenerate"]>>;
    },
  } as unknown as LanguageModelV3;
}
