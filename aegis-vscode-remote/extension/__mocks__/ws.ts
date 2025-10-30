import { EventEmitter } from 'events';

type MessageData = string | Buffer | ArrayBuffer | Uint8Array;

const OPEN = 1;
const CLOSED = 3;

class MockWebSocket extends EventEmitter {
  static CONNECTING = 0;
  static OPEN = OPEN;
  static CLOSING = 2;
  static CLOSED = CLOSED;

  readyState = MockWebSocket.OPEN;
  binaryType: string = 'nodebuffer';

  constructor(public readonly url: string, public readonly options?: any) {
    super();
    setImmediate(() => {
      this.emit('open');
    });
  }

  send(data: MessageData) {
    if (this.readyState !== MockWebSocket.OPEN) {
      return;
    }
    const buffer =
      data instanceof Buffer
        ? Buffer.from(data)
        : data instanceof Uint8Array
          ? Buffer.from(data)
          : data instanceof ArrayBuffer
            ? Buffer.from(data)
            : Buffer.from(String(data));
    setImmediate(() => {
      this.emit('message', buffer);
    });
  }

  ping() {
    setImmediate(() => {
      this.emit('pong');
    });
  }

  terminate() {
    this.close();
  }

  close() {
    if (this.readyState === MockWebSocket.CLOSED) {
      return;
    }
    this.readyState = MockWebSocket.CLOSING;
    setImmediate(() => {
      this.readyState = MockWebSocket.CLOSED;
      this.emit('close', 1000, '');
    });
  }
}

export default MockWebSocket;
module.exports = MockWebSocket;
module.exports.default = MockWebSocket;
module.exports.WebSocket = MockWebSocket;
