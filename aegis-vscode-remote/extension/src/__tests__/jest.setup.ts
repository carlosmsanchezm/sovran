import { jest } from '@jest/globals';

jest.setTimeout(30000);

process.on('unhandledRejection', (err) => {
  // eslint-disable-next-line no-console
  console.error('unhandledRejection', err);
  throw err instanceof Error ? err : new Error(String(err));
});
