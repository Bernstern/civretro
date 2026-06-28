import WebSocket from "ws";

const CDP_URI = "ws://172.17.0.1:9444/devtools/page/0";

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };

export class CDP {
  private ws: WebSocket | null = null;
  private id = 0;
  private pending = new Map<number, Pending>();

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(CDP_URI);
      ws.on("open", () => { this.ws = ws; resolve(); });
      ws.on("error", reject);
      ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString()) as {
          id?: number;
          result?: { result?: CdpResult };
          error?: { message: string };
        };
        if (msg.id == null) return;
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        if (msg.error) { p.reject(new Error(msg.error.message)); return; }
        p.resolve(extractValue(msg.result?.result));
      });
    });
  }

  async close(): Promise<void> {
    this.ws?.close();
    this.ws = null;
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  async eval<T = unknown>(js: string, timeoutMs = 10_000): Promise<T> {
    if (!this.ws) throw new Error("not connected");
    const id = ++this.id;
    const result = await new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP eval timeout (${timeoutMs}ms)`));
        }
      }, timeoutMs);
      this.ws!.send(JSON.stringify({
        id,
        method: "Runtime.evaluate",
        params: { expression: js, returnByValue: true },
      }));
    });
    return result as T;
  }
}

interface CdpResult {
  type: string;
  subtype?: string;
  value?: unknown;
  description?: string;
  className?: string;
}

function extractValue(r: CdpResult | undefined): unknown {
  if (!r) return null;
  if (r.type === "undefined") return undefined;
  if (r.type === "object" && r.subtype === "null") return null;
  if (r.type === "object" && r.subtype === "error") throw new Error(r.description ?? "JS exception");
  if (r.type === "string" || r.type === "number" || r.type === "boolean") return r.value;
  return r.value ?? null;
}
