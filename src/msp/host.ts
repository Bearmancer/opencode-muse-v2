import {
  MspError,
  checkServedFingerprint,
  EXPECTED_SCHEMA_FINGERPRINT,
  MuseHostStartError as SdkHostStartError,
  spawnMspConnection,
  type FingerprintWarning,
  type MspHandshake,
  type SpawnMspConnectionOptions,
} from "@muse-code/sdk";
import {
  MspCommandTimeoutError,
  MspHostClosedError,
  MspHostStartError,
  MspInitializeRejectedError,
  MspSchemaMismatchError,
  MspStartupTimeoutError,
  MspTransportError,
} from "../errors.js";
import { MspClient, type MspConnectionLike, type MspNotification, type MspServerRequest } from "./client.js";
import { museChildEnv } from "./contributor.js";

export interface MspHostRuntime {
  connection: MspConnectionLike;
  initializeResult: Record<string, unknown>;
  close(): Promise<unknown>;
  exited?: Promise<unknown>;
}

export interface MspHandshakeLike {
  initialize(params: Parameters<MspHandshake["initialize"]>[0]): Promise<MspHostRuntime>;
  close(): Promise<unknown>;
}

export interface MspHostOptions {
  museBin?: string;
  args?: readonly string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  startupTimeoutMs?: number;
  commandTimeoutMs?: number;
  requestTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  clientInfo?: { name: string; version: string };
  capabilities?: Parameters<MspHandshake["initialize"]>[0]["capabilities"];
  onServerRequest?: (request: MspServerRequest) => Promise<Record<string, unknown>>;
}

export interface MspHostDependencies {
  createHandshake?: (options: SpawnMspConnectionOptions) => MspHandshakeLike;
}

export interface MspHostExit {
  kind: string;
  exitCode?: number | null;
  exitSignal?: string | null;
  retry?: string;
}

function defaultHandshake(options: SpawnMspConnectionOptions): MspHandshakeLike {
  const handshake = spawnMspConnection(options);
  return {
    async initialize(params) {
      const spawned = await handshake.initialize(params);
      return {
        connection: spawned.connection,
        initializeResult: { ...spawned.initializeResult },
        exited: spawned.child.exit,
        close: async () => spawned.close(),
      };
    },
    close: async () => handshake.close(),
  };
}

function sanitizeExit(value: unknown): MspHostExit {
  if (typeof value !== "object" || value === null) return { kind: "unknown" };
  const record = value as Record<string, unknown>;
  const safe: MspHostExit = {
    kind: typeof record.kind === "string" ? record.kind : "unknown",
  };
  if (typeof record.exitCode === "number" || record.exitCode === null) safe.exitCode = record.exitCode;
  if (typeof record.exitSignal === "string" || record.exitSignal === null) safe.exitSignal = record.exitSignal;
  if (typeof record.retry === "string") safe.retry = record.retry;
  
  return safe;
}

const SCHEMA_FINGERPRINT_PATTERN = /^sha256:[0-9a-f]{64}$/;


const SUPPORTED_SCHEMA_VERSION = 1;

function readSchemaInfo(value: unknown): { fingerprint: string; version?: unknown } | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as { fingerprint?: unknown; version?: unknown };
  if (typeof record.fingerprint !== "string") return undefined;
  return { fingerprint: record.fingerprint, version: record.version };
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => {
      timer = setTimeout(() => reject(new MspStartupTimeoutError(timeoutMs)), timeoutMs);
    }),
  ]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

async function closeQuietly(close: () => Promise<unknown>): Promise<void> {
  try {
    await close();
  } catch {
    
  }
}


export class MspHost {
  readonly client: MspClient;
  readonly initializeResult: Record<string, unknown>;
  
  readonly fingerprintWarning?: FingerprintWarning;
  readonly exited: Promise<MspHostExit>;
  private state: "open" | "closing" | "closed" = "open";
  private closePromise: Promise<void> | undefined;

  private constructor(
    private readonly runtime: MspHostRuntime,
    options: MspHostOptions,
    fingerprintWarning?: FingerprintWarning,
  ) {
    this.initializeResult = runtime.initializeResult;
    this.fingerprintWarning = fingerprintWarning;
    const customServerRequest = options.onServerRequest;
    this.client = new MspClient(runtime.connection, {
      commandTimeoutMs: options.commandTimeoutMs,
      requestTimeoutMs: options.requestTimeoutMs,
      closeConnection: false,
      onServerRequest: customServerRequest
        ? (request) => customServerRequest(request)
        : (request) => this.handleServerRequest(request),
      onFatal: () => {
        queueMicrotask(() => { void this.close().catch(() => {}); });
      },
    });
    this.exited = runtime.exited
      ? runtime.exited.then(
          (value) => {
            this.state = "closed";
            this.client.dispose();
            return sanitizeExit(value);
          },
          () => {
            this.state = "closed";
            this.client.dispose();
            return { kind: "unknown" };
          },
        )
      : new Promise(() => {});
  }

  static async start(options: MspHostOptions = {}, dependencies: MspHostDependencies = {}): Promise<MspHost> {
    const spawnOptions: SpawnMspConnectionOptions = {
      command: options.museBin ?? "muse",
      args: options.args,
      cwd: options.cwd,
      env: museChildEnv(options.env ?? process.env),
      
      shutdownTimeoutMs: options.shutdownTimeoutMs ?? 30_000,
    };
    let handshake: MspHandshakeLike;
    try {
      handshake = (dependencies.createHandshake ?? defaultHandshake)(spawnOptions);
    } catch {
      throw new MspHostStartError("spawn-failed");
    }

    const initializeParams = {
      clientInfo: options.clientInfo ?? { name: "opencode_muse", version: "0.1.0" },
      ...(options.capabilities ? { capabilities: options.capabilities } : {}),
    };
    const timeoutMs = options.startupTimeoutMs ?? 20_000;
    const initializing = handshake.initialize(initializeParams);
    try {
      const runtime = await withTimeout(initializing, timeoutMs);
      const schema = readSchemaInfo(runtime.initializeResult.schema);
      const servedFingerprint = schema?.fingerprint ?? "missing";
      if (
        schema === undefined ||
        !SCHEMA_FINGERPRINT_PATTERN.test(schema.fingerprint) ||
        (schema.version !== undefined && schema.version !== SUPPORTED_SCHEMA_VERSION)
      ) {
        await closeQuietly(runtime.close.bind(runtime));
        throw new MspSchemaMismatchError(EXPECTED_SCHEMA_FINGERPRINT, servedFingerprint);
      }
      return new MspHost(runtime, options, checkServedFingerprint(schema.fingerprint));
    } catch (error) {
      if (error instanceof MspSchemaMismatchError) throw error;
      if (error instanceof MspStartupTimeoutError) {
        void initializing.then((runtime) => closeQuietly(runtime.close.bind(runtime))).catch(() => {});
        await closeQuietly(handshake.close.bind(handshake));
        throw error;
      }
      await closeQuietly(handshake.close.bind(handshake));
      if (error instanceof MspError) throw new MspInitializeRejectedError(error.code, error.kind);
      if (error instanceof SdkHostStartError) {
        throw new MspHostStartError(error.failure.kind === "spawnFailed" ? "spawn-failed" : "host-exited");
      }
      throw new MspHostStartError("unknown");
    }
  }

  get isClosed(): boolean {
    return this.state !== "open";
  }

  mintCommandId(): string {
    if (this.state !== "open") throw new MspHostClosedError();
    return this.client.mintCommandId();
  }

  command<TResult extends object = Record<string, unknown>>(
    method: string,
    paramsWithCommandId: Record<string, unknown> & { commandId: string },
  ): Promise<TResult> {
    if (this.state !== "open") return Promise.reject(new MspHostClosedError());
    return this.client.command<TResult>(method, paramsWithCommandId).catch((error: unknown) => {
      if (error instanceof MspCommandTimeoutError) void this.close().catch(() => {});
      throw error;
    });
  }

  request<TResult extends object = Record<string, unknown>>(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<TResult> {
    if (this.state !== "open") return Promise.reject(new MspHostClosedError());
    return this.client.request<TResult>(method, params);
  }

  subscribe(sessionId: string, after?: string, signal?: AbortSignal): AsyncIterable<MspNotification> {
    if (this.state !== "open") throw new MspHostClosedError();
    return this.client.subscribe(sessionId, after, signal);
  }

  private async handleServerRequest(request: MspServerRequest): Promise<Record<string, unknown>> {
    if (request.method === "approval/request") return this.handleApprovalRequest(request.params);
    if (request.method === "userInput/request") return this.handleUserInputRequest(request.params);
    
    
    throw new MspError({
      code: -32601,
      message: `method not found: ${request.method}`,
      data: { kind: "methodNotFound", retryable: false },
    });
  }

  private async handleApprovalRequest(params: Record<string, unknown> | undefined): Promise<Record<string, unknown>> {
    const raw = (params ?? {}) as {
      approvalId?: unknown;
      sessionId?: unknown;
      currentRequirementId?: unknown;
      availableChoices?: unknown;
    };
    if (
      typeof raw.approvalId !== "string"
      || typeof raw.sessionId !== "string"
      || !Array.isArray(raw.availableChoices)
    ) {
      return {};
    }
    const approve = raw.availableChoices.find((entry): entry is { choiceId: string } =>
      typeof entry === "object" && entry !== null
      && (entry as Record<string, unknown>).decision === "approve"
      && typeof (entry as Record<string, unknown>).choiceId === "string",
    );
    if (approve !== undefined) {
      try {
        await this.command("approval/decide", {
          commandId: this.client.mintCommandId(),
          sessionId: raw.sessionId,
          approvalId: raw.approvalId,
          requirementId: raw.currentRequirementId,
          choiceId: approve.choiceId,
        });
      } catch {
      }
    }
    return {};
  }

  private async handleUserInputRequest(params: Record<string, unknown> | undefined): Promise<Record<string, unknown>> {
    const raw = (params ?? {}) as { sessionId?: unknown; userInputId?: unknown };
    if (typeof raw.sessionId !== "string" || typeof raw.userInputId !== "string") return {};
    try {
      await this.command("userInput/cancel", {
        commandId: this.client.mintCommandId(),
        sessionId: raw.sessionId,
        userInputId: raw.userInputId,
        reason: "cancelled",
      });
    } catch {
    }
    return {};
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.state = "closing";
    this.client.dispose();
    this.closePromise = this.runtime.close().then(
      () => { this.state = "closed"; },
      () => {
        this.state = "closed";
        throw new MspTransportError();
      },
    );
    return this.closePromise;
  }
}
