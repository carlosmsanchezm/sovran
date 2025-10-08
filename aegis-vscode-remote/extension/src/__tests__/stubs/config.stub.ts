export type LogLevel = 'info' | 'debug' | 'trace';

export function getSettings() {
  return {
    heartbeatIntervalMs: 200,
    idleTimeoutMs: 600,
    logLevel: 'debug' as LogLevel,
    security: { rejectUnauthorized: false, caPath: '' },
    defaultWorkspaceId: 'w-test',
  };
}

export function onDidChangeSettings(cb: () => void) {
  return { dispose() {} };
}
