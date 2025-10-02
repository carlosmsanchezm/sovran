"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ConnectionManager = void 0;
const vscode = __importStar(require("vscode"));
const ws_1 = __importDefault(require("ws"));
class ConnectionManager {
    url;
    opts;
    attempt = 0;
    lastRxAt = 0;
    lastTxAt = 0;
    startAt = 0;
    hb;
    idleTimer;
    metrics = { attempt: 0, bytesRx: 0, bytesTx: 0 };
    constructor(url, opts) {
        this.url = url;
        this.opts = opts;
    }
    open() {
        const onRx = new vscode.EventEmitter();
        const onClose = new vscode.EventEmitter();
        const onEnd = new vscode.EventEmitter();
        this.attempt += 1;
        this.metrics = { attempt: this.attempt, bytesRx: 0, bytesTx: 0 };
        this.startAt = Date.now();
        return new Promise((resolve, reject) => {
            const wsOptions = {
                perMessageDeflate: false,
                rejectUnauthorized: this.opts.rejectUnauthorized !== false,
                headers: this.opts.headers,
                ca: this.opts.tls?.ca,
                cert: this.opts.tls?.cert,
                key: this.opts.tls?.key,
            };
            if (this.opts.tls?.servername) {
                wsOptions.servername = this.opts.tls.servername;
            }
            const ws = new ws_1.default(this.url, wsOptions);
            ws.binaryType = 'arraybuffer';
            ws.on('unexpected-response', (_req, res) => {
                const status = res.statusCode ?? 0;
                this.opts.log(`[conn] unexpected response status=${status}`);
                let body = '';
                res.on('data', (chunk) => {
                    if (body.length > 4096) {
                        return;
                    }
                    body += chunk instanceof Buffer ? chunk.toString('utf8') : String(chunk);
                });
                res.on('end', () => {
                    if (body) {
                        const snippet = body.length > 4096 ? `${body.slice(0, 4096)}…` : body;
                        this.opts.log(`[conn] unexpected response body=${snippet}`);
                    }
                });
            });
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
            const finish = (err) => {
                clearTimers();
                try {
                    onClose.fire(err);
                }
                catch (ex) {
                    this.debug(`[conn] error delivering close event: ${String(ex)}`);
                }
                try {
                    onEnd.fire();
                }
                catch (ex) {
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
                    }
                    catch (err) {
                        this.debug(`[conn] ping failed: ${String(err)}`);
                    }
                }, Math.max(1_000, this.opts.heartbeatIntervalMs));
                this.idleTimer = setInterval(() => {
                    const idleFor = Date.now() - this.lastRxAt;
                    if (idleFor > this.opts.idleTimeoutMs) {
                        this.opts.log(`[conn] idle ${idleFor}ms > ${this.opts.idleTimeoutMs}ms → terminate`);
                        try {
                            ws.terminate();
                        }
                        catch (err) {
                            this.debug(`[conn] terminate failed: ${String(err)}`);
                        }
                    }
                }, Math.max(1_000, Math.min(this.opts.idleTimeoutMs / 3, 5_000)));
                resolve({
                    onDidReceiveMessage: onRx.event,
                    onDidClose: onClose.event,
                    onDidEnd: onEnd.event,
                    send: (data) => {
                        try {
                            if (ws.readyState === ws_1.default.OPEN) {
                                ws.send(data);
                                this.lastTxAt = Date.now();
                                this.metrics.bytesTx += data.byteLength;
                            }
                        }
                        catch (err) {
                            this.debug(`[conn] send failed: ${String(err)}`);
                        }
                    },
                    end: () => {
                        try {
                            ws.close();
                        }
                        catch (err) {
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
                const buf = data instanceof Buffer ? data : Buffer.from(data);
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
                const summary = error?.message ? `${error.message}` : String(error ?? 'unknown error');
                this.opts.log(`[conn] error ${summary}`);
                if (ws.readyState === ws_1.default.CONNECTING) {
                    clearTimers();
                    reject(error);
                }
                else {
                    finish(error);
                }
            });
        });
    }
    getMetrics() {
        return { ...this.metrics };
    }
    debug(message) {
        if (this.opts.logLevel === 'debug' || this.opts.logLevel === 'trace') {
            this.opts.log(message);
        }
    }
}
exports.ConnectionManager = ConnectionManager;
