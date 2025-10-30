import { beforeEach, describe, expect, jest, test } from '@jest/globals';
jest.mock('ws');
import { AegisResolver } from '../../resolver';
import { ConnectionManager } from '../../connection';
import { status } from '../stubs/ui.stub';

describe('resolver ↔ proxy integration', () => {
  beforeEach(() => {
    jest.restoreAllMocks();
    (status.set as jest.Mock).mockClear();
  });

  test('establishes transport over proxy and echoes bytes', async () => {
    const createEmitter = <T,>() => {
      const listeners: Array<(value: T) => void> = [];
      const event = (listener: (value: T) => any) => {
        listeners.push(listener);
        return {
          dispose: () => {
            const idx = listeners.indexOf(listener);
            if (idx >= 0) {
              listeners.splice(idx, 1);
            }
          },
        };
      };
      return {
        event,
        fire: (value: T) => {
          for (const listener of [...listeners]) {
            listener(value);
          }
        },
      };
    };

    jest.spyOn(ConnectionManager.prototype, 'open').mockImplementation(function (this: any) {
      const rx = createEmitter<Uint8Array>();
      const onClose = createEmitter<Error | undefined>();
      const onEnd = createEmitter<void>();
      return Promise.resolve({
        onDidReceiveMessage: rx.event,
        onDidClose: onClose.event,
        onDidEnd: onEnd.event,
        send: (data: Uint8Array) => {
          rx.fire(data);
        },
        end: () => {
          onClose.fire(undefined);
          onEnd.fire();
        },
      });
    });

    const result = await AegisResolver.resolve('aegis+w-int', { resolveAttempt: 1 } as any);
    const transport = await (result as any).opener();

    const received: Uint8Array[] = [];
    const disposeRx = transport.onDidReceiveMessage((data: Uint8Array) => {
      received.push(data);
    });

    const closePromise = new Promise<void>((resolve) => transport.onDidEnd(() => resolve()));

    const payload = new Uint8Array([1, 2, 3]);
    transport.send(payload);

    const start = Date.now();
    while (received.length === 0) {
      if (Date.now() - start > 5000) {
        throw new Error('Timed out waiting for echo');
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    expect(Array.from(received[0])).toEqual([1, 2, 3]);

    transport.end();
    await closePromise;
    disposeRx?.dispose?.();

    const calls = (status.set as jest.Mock).mock.calls.flatMap((args) => args);
    const joined = calls.map((arg) => String(arg));
    expect(joined.some((msg) => msg.includes('Connected'))).toBe(true);
    expect(joined.some((msg) => msg.includes('Disconnected'))).toBe(true);
  });
});
