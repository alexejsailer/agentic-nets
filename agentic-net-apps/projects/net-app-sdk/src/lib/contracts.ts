export interface NetApplicationContext {
  modelId: string;
  sessionId: string;
  installationId: string;
  name: string;
  version?: string;
}

export interface ApplicationStoreToken<T extends object = Record<string, unknown>> {
  id: string;
  name: string;
  properties: T;
}

export interface ApplicationDescriptor {
  sessionId: string;
  name: string;
  displayName?: string;
  description?: string;
  stores: Array<{ role: string; description?: string; required?: boolean }>;
  actions: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>;
  agentProtocol?: Record<string, unknown>;
  installedFrom?: { name?: string; version?: string; source?: string; installedAt?: string };
}

export interface NetApplicationSnapshotEvent<T extends object = Record<string, unknown>> {
  type: 'snapshot';
  role: string;
  tokens: Array<ApplicationStoreToken<T>>;
}

/** Rejection shape used by runtime.invoke; status 409 means optimistic contention. */
export interface NetApplicationActionError extends Error {
  status?: number;
  code?: 'conflict' | 'rejected' | 'forbidden' | 'unavailable';
}

export interface NetApplicationInvokeOptions {
  /** Stable per logical attempt; reuse only for the exact same action input. */
  idempotencyKey?: string;
}

/** Stable capability object supplied by Studio as the custom element's `runtime` property. */
export interface NetApplicationRuntime {
  readonly context: NetApplicationContext;
  describe(): Promise<ApplicationDescriptor>;
  readStore<T extends object = Record<string, unknown>>(
    role: string,
  ): Promise<Array<ApplicationStoreToken<T>>>;
  watchStore<T extends object = Record<string, unknown>>(
    role: string,
    listener: (event: NetApplicationSnapshotEvent<T>) => void,
    intervalMs?: number,
  ): () => void;
  invoke<T = unknown>(
    action: string,
    input: Record<string, unknown>,
    options?: NetApplicationInvokeOptions,
  ): Promise<T>;
  navigate(command: 'open-app-index' | 'open-underlying-net'): void;
}

export interface NetApplicationElement extends HTMLElement {
  runtime?: NetApplicationRuntime;
}
