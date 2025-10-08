import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import { AegisResolver } from '../../resolver';
import { status } from '../stubs/ui.stub';

describe('resolver ↔ proxy integration', () => {
  beforeEach(() => {
    (status.set as jest.Mock).mockClear();
  });

  test('establishes transport over proxy and echoes bytes', async () => {
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
