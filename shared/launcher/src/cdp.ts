/**
 * Coherent Gameface CDP client — queries Civ 7's V8 runtime via Chrome DevTools Protocol.
 *
 * Endpoint: ws://<host>:9444/devtools/page/0
 * No auth, no handshake beyond WebSocket upgrade.
 * Works in both SP and MP (confirmed); does not require EnableTuner.
 */

import WebSocket from 'ws';
import { z } from 'zod';

import { getLogger } from './log.js';

const log = getLogger('civretro.cdp');

export const CDP_HOST = '172.17.0.1'; // WSL2: Windows host = default gateway
export const CDP_PORT = 9444;
export const CDP_PAGE = 'devtools/page/0';

export interface CdpClient {
  connect(): Promise<void>;
  close(): Promise<void>;
  eval(js: string, timeoutSec?: number): Promise<unknown>;
  connected(): boolean;
  /**
   * Hack: adopt another client's live WebSocket so all callers holding a
   * reference to this client automatically get the new socket (see safeEval).
   */
  transplantSocket(other: CdpClient): void;
}

// Per-client live socket, kept out of the public surface so transplantSocket can
// move a socket between two client objects without exposing the raw handle.
const sockets = new WeakMap<CdpClient, WebSocket | null>();

/** Send one CDP message and resolve with the next received frame, or reject on timeout. */
const sendAndRecv = (ws: WebSocket, msg: string, timeoutMs: number): Promise<string> =>
  new Promise<string>((resolve, reject) => {
    const cleanup = (): void => {
      clearTimeout(timer);
      ws.off('message', onMessage);
      ws.off('close', onClose);
      ws.off('error', onError);
    };
    const onMessage = (data: WebSocket.RawData): void => {
      cleanup();
      resolve(data.toString());
    };
    const onClose = (): void => {
      cleanup();
      reject(new Error('CDP socket closed during eval'));
    };
    const onError = (err: Error): void => {
      cleanup();
      reject(err);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`CDP eval timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    ws.on('message', onMessage);
    ws.on('close', onClose);
    ws.on('error', onError);
    ws.send(msg, (err) => {
      if (err) {
        cleanup();
        reject(err);
      }
    });
  });

// Shape of a Runtime.evaluate response frame (everything optional — it is
// external data off the CDP socket, parsed at this boundary).
const CdpFrameSchema = z.object({
  result: z
    .object({
      result: z.object({ type: z.string(), value: z.unknown() }).partial(),
    })
    .partial(),
});

export const createCdpClient = (host: string = CDP_HOST, port: number = CDP_PORT): CdpClient => {
  const uri = `ws://${host}:${port}/${CDP_PAGE}`;
  let msgId = 0;

  const client: CdpClient = {
    connected(): boolean {
      const ws = sockets.get(client);
      return ws != null && ws.readyState === WebSocket.OPEN;
    },

    connect(): Promise<void> {
      log.debug(`connecting to ${uri}`);
      return new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(uri);
        const timer = setTimeout(() => {
          ws.terminate();
          reject(new Error(`CDP connect to ${uri} timed out`));
        }, 5000); // open_timeout=5
        ws.once('open', () => {
          clearTimeout(timer);
          sockets.set(client, ws);
          log.debug(`connected to ${uri}`);
          resolve();
        });
        ws.once('error', (err) => {
          clearTimeout(timer);
          reject(err);
        });
      });
    },

    async close(): Promise<void> {
      const ws = sockets.get(client);
      if (ws) {
        log.debug('closing CDP connection');
        ws.close();
        sockets.set(client, null);
      }
    },

    async eval(js: string, timeoutSec = 20.0): Promise<unknown> {
      const ws = sockets.get(client);
      if (!ws) throw new Error('CDP eval failed: not connected');
      msgId += 1;
      const msg = JSON.stringify({
        id: msgId,
        method: 'Runtime.evaluate',
        params: { expression: js, returnByValue: true },
      });
      const raw = await sendAndRecv(ws, msg, timeoutSec * 1000);
      const parsed = CdpFrameSchema.safeParse(JSON.parse(raw));
      const result = parsed.success ? (parsed.data.result?.result ?? {}) : {};
      const t = result.type;
      if (t === 'string' || t === 'boolean' || t === 'number') return result.value;
      if (t === 'undefined') return null;
      return result;
    },

    transplantSocket(other: CdpClient): void {
      sockets.set(client, sockets.get(other) ?? null);
    },
  };

  sockets.set(client, null);
  return client;
};

/** Thin shim for backward compatibility — delegates to CdpClient.eval(). */
export const evalAny = (c: CdpClient, js: string, timeoutSec = 20.0): Promise<unknown> =>
  c.eval(js, timeoutSec);
