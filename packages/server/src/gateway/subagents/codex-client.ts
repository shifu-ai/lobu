import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

type RpcMessage = { id?: number | string; method?: string; params?: Record<string, unknown>; result?: unknown; error?: unknown };
type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };

// 每個實際子程序自己的 RPC transport；任務、lease、授權狀態不儲存在這裡。
export class CodexAppServerClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Set<(message: RpcMessage) => void>();
  private readonly closeListeners = new Set<() => void>();
  private readonly stoppedPromise: Promise<void>;
  private resolveStopped!: () => void;
  private nextId = 0;
  private closed = false;
  private killTimer?: ReturnType<typeof setTimeout>;
  private readonly refreshAuth?: (params: Record<string, unknown>) => Promise<unknown>;

  constructor(options: { binary: string; cwd: string; env: Record<string, string>; args?: string[];
    refreshAuth?: (params: Record<string, unknown>) => Promise<unknown> }) {
    this.refreshAuth = options.refreshAuth;
    this.stoppedPromise = new Promise((resolve) => { this.resolveStopped = resolve; });
    this.child = spawn(options.binary, options.args ?? ["app-server", "--listen", "stdio://"], {
      cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32",
    });
    const decoder = new StringDecoder("utf8");
    let buffer = "";
    this.child.stdout.on("data", (chunk: Buffer) => {
      buffer += decoder.write(chunk);
      if (Buffer.byteLength(buffer) > 2 * 1024 * 1024) { this.close(); return; }
      let newline: number;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        try { this.receive(JSON.parse(line)); } catch { this.close(); return; }
      }
    });
    // 排空 stderr，但不保存／回傳可能帶有 token 的 provider 錯誤。
    this.child.stderr.resume();
    this.child.stdin.on("error", () => this.close());
    this.child.on("error", () => this.close());
    this.child.on("close", () => {
      // app-server 先退出時，仍可能留下同組背景程序；不可只撤掉升級終止計時器。
      this.killProcessGroup("SIGKILL");
      this.resolveStopped(); this.finish();
      if (this.killTimer) clearTimeout(this.killTimer);
    });
  }

  async initialize(): Promise<void> {
    await this.request("initialize", {
      clientInfo: { name: "shifu_subagent", title: "ShiFu Subagent", version: "1.0.0" },
      capabilities: { experimentalApi: true },
    });
    this.write({ method: "initialized", params: {} });
  }

  request<T = unknown>(method: string, params: Record<string, unknown>, timeoutMs = 30_000): Promise<T> {
    if (this.closed) return Promise.reject(new Error("codex_process_closed"));
    const id = ++this.nextId;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id); reject(new Error("codex_rpc_timeout")); this.close();
      }, timeoutMs);
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject, timer });
      this.write({ id, method, params });
    });
  }

  subscribe(listener: (message: RpcMessage) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  waitNotification(method: string, predicate: (params: Record<string, unknown>) => boolean, signal: AbortSignal): Promise<Record<string, unknown>> {
    if (this.closed || signal.aborted) return Promise.reject(new Error("codex_execution_aborted"));
    return new Promise((resolve, reject) => {
      const cleanup = () => { unsubscribe(); this.closeListeners.delete(onClose); signal.removeEventListener("abort", onAbort); };
      const onClose = () => { cleanup(); reject(new Error("codex_process_closed")); };
      const onAbort = () => { cleanup(); reject(new Error("codex_execution_aborted")); };
      const unsubscribe = this.subscribe((message) => {
        if (message.method === method && message.params && predicate(message.params)) { cleanup(); resolve(message.params); }
      });
      this.closeListeners.add(onClose);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  async stop(): Promise<void> {
    this.close();
    await this.stoppedPromise;
  }

  close(): void {
    if (this.closed) return;
    this.finish();
    this.killProcessGroup("SIGTERM");
    this.killTimer = setTimeout(() => this.killProcessGroup("SIGKILL"), 1000);
    this.killTimer.unref();
  }

  private killProcessGroup(signal: NodeJS.Signals): void {
    try {
      if (this.child.pid && process.platform !== "win32") process.kill(-this.child.pid, signal);
      else this.child.kill(signal);
    } catch { /* 已結束的 process group 無需再處理。 */ }
  }

  private finish(): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error("codex_process_closed")); }
    this.pending.clear();
    for (const listener of [...this.closeListeners]) listener();
    this.listeners.clear();
  }

  private write(message: RpcMessage): void {
    if (!this.closed) this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private receive(message: RpcMessage): void {
    if (!message || typeof message !== "object" || Array.isArray(message)) { this.close(); return; }
    if (typeof message.id === "number" && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer); this.pending.delete(message.id);
      if (message.error) pending.reject(new Error("codex_rpc_rejected"));
      else pending.resolve(message.result);
    } else if (message.id !== undefined && message.method) {
      if (message.method === "account/chatgptAuthTokens/refresh" && this.refreshAuth) {
        void this.refreshAuth(message.params ?? {}).then(
          result => this.write({ id: message.id, result }),
          () => this.write({ id: message.id, error: { code: -32000, message: "Account reconnection required" } }),
        );
        return;
      }
      // 子代理的外部寫入與擴權不可被自動核准。
      if (message.method.endsWith("/requestApproval")) this.write({ id: message.id, result: { decision: "decline" } });
      else this.write({ id: message.id, error: { code: -32601, message: "Subagent action not permitted" } });
    } else {
      for (const listener of this.listeners) listener(message);
    }
  }
}
