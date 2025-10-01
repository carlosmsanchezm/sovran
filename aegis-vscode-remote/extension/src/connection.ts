import * as vscode from 'vscode';
import WebSocket from 'ws';
import { LogLevel } from './config';

export interface Managed {
  readonly onDidReceiveMessage: vscode.Event<Uint8Array>;
  readonly onDidClose: vscode.Event<Error | undefined>;
  readonly onDidEnd: vscode.Event<void>;
  send(data: Uint8Array): void;
  end(): void;
}

export interface ConnMetrics {
  attempt: number;
  bytesTx: number;
  bytesRx: number;
  lastClose?: { code?: number; reason?: string };
  rttMs?: number;
  lastError?: string;
  lastHeartbeatAt?: number;
  lastMessageAt?: number;
}

export interface ConnectionOptions {
  heartbeatIntervalMs: number;
  idleTimeoutMs: number;
  tlsInsecure: boolean;
  logLevel: LogLevel;
  log: (message: string) => void;
}

export class ConnectionManager {
  private attempt = 0;
  private lastRxAt = 0;
  private lastTxAt = 0;
  private startAt = 0;
  private hb?: NodeJS.Timeout;
  private idleTimer?: NodeJS.Timeout;
  private metrics: ConnMetrics = { attempt: 0, bytesRx: 0, bytesTx: 0 };

  constructor(private url: string, private opts: ConnectionOptions) {}

  open(): Thenable<Managed> {
    const onRx = new vscode.EventEmitter<Uint8Array>();
    const onClose = new vscode.EventEmitter<Error | undefined>();
    const onEnd = new vscode.EventEmitter<void>();

    this.attempt += 1;
    this.metrics = { attempt: this.attempt, bytesRx: 0, bytesTx: 0 };
    this.startAt = Date.now();

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url, {
        perMessageDeflate: false,
        rejectUnauthorized: !this.opts.tlsInsecure,
      });
      ws.binaryType = 'arraybuffer';

      const clearTimers = () => {
        if (this.hb) {
          clearInterval(this.hb);
          this.hb = undefined;
        }
        if (this.idleTimer) {
          clearInterval(this.idleTimer);
          this.idleTimer = undefined;
        }
      };

      const finish = (err?: Error) => {
        clearTimers();
        try {
          onClose.fire(err);
        } catch (ex) {
          this.debug(`[conn] error delivering close event: ${String(ex)}`);
        }
        try {
          onEnd.fire();
        } catch (ex) {
          this.debug(`[conn] error delivering end event: ${String(ex)}`);
        }
      };

      ws.on('open', () => {
        const rtt = Date.now() - this.startAt;
        this.metrics.rttMs = rtt;
        this.lastRxAt = Date.now();
        this.opts.log(`[conn] open attempt=${this.attempt} rtt=${rtt}ms`);

        this.hb = setInterval(() => {
          try {
            ws.ping();
            this.metrics.lastHeartbeatAt = Date.now();
          } catch (err) {
            this.debug(`[conn] ping failed: ${String(err)}`);
          }
        }, Math.max(1_000, this.opts.heartbeatIntervalMs));

        this.idleTimer = setInterval(() => {
          const idleFor = Date.now() - this.lastRxAt;
          if (idleFor > this.opts.idleTimeoutMs) {
            this.opts.log(`[conn] idle ${idleFor}ms > ${this.opts.idleTimeoutMs}ms → terminate`);
            try {
              ws.terminate();
            } catch (err) {
              this.debug(`[conn] terminate failed: ${String(err)}`);
            }
          }
        }, Math.max(1_000, Math.min(this.opts.idleTimeoutMs / 3, 5_000)));

        resolve({
          onDidReceiveMessage: onRx.event,
          onDidClose: onClose.event,
          onDidEnd: onEnd.event,
          send: (data: Uint8Array) => {
            try {
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(data);
                this.lastTxAt = Date.now();
                this.metrics.bytesTx += data.byteLength;
              }
            } catch (err) {
              this.debug(`[conn] send failed: ${String(err)}`);
            }
          },
          end: () => {
            try {
              ws.close();
            } catch (err) {
              this.debug(`[conn] close failed: ${String(err)}`);
            }
          },
        });
      });

      ws.on('pong', () => {
        const now = Date.now();
        this.metrics.lastHeartbeatAt = now;
        this.lastRxAt = now;
      });

      ws.on('message', (data) => {
        const buf = data instanceof Buffer ? data : Buffer.from(data as ArrayBuffer);
        this.lastRxAt = Date.now();
        this.metrics.lastMessageAt = this.lastRxAt;
        this.metrics.bytesRx += buf.length;
        onRx.fire(buf);
      });

      ws.on('close', (code, reason) => {
        this.metrics.lastClose = { code, reason: reason?.toString() };
        this.opts.log(`[conn] close code=${code} reason=${reason}`);
        finish();
      });

      ws.on('error', (err) => {
        const error = err instanceof Error ? err : new Error(String(err));
        this.metrics.lastError = error.message;
        this.opts.log(`[conn] error ${error.message}`);
        if (ws.readyState === WebSocket.CONNECTING) {
          clearTimers();
          reject(error);
        } else {
          finish(error);
        }
      });
    });
  }

  getMetrics(): ConnMetrics {
    return { ...this.metrics };
  }

  private debug(message: string) {
    if (this.opts.logLevel === 'debug' || this.opts.logLevel === 'trace') {
      this.opts.log(message);
    }
  }
}
