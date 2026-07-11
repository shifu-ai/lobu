type Fetcher = typeof fetch;

export type ToolboxCourseContextClientOptions = { baseUrl: string; secret: string; timeoutMs?: number; fetcher?: Fetcher };

export class ToolboxCourseContextClient {
  constructor(private readonly options: ToolboxCourseContextClientOptions) {}

  private async request(path: string, init?: RequestInit): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 1500);
    try {
      const response = await (this.options.fetcher ?? fetch)(`${this.options.baseUrl.replace(/\/$/, '')}${path}`, { ...init, signal: controller.signal, headers: { ...init?.headers, 'x-internal-secret': this.options.secret } });
      if (!response.ok) throw new Error(`Toolbox course context request failed (${response.status})`);
      return await response.json() as Record<string, unknown>;
    } finally { clearTimeout(timeout); }
  }

  resolve(input: { ownerUserId: string; agentId: string; conversationId: string; message: string }) {
    return this.request('/internal/resolve', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
  }
  bundle(courseKey: string, input: { ownerUserId: string; agentId: string }) {
    const query = new URLSearchParams(input);
    return this.request(`/internal/courses/${encodeURIComponent(courseKey)}?${query}`);
  }
}
