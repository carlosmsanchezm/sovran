export type LogLevel = 'info' | 'debug' | 'trace';

export function getSettings() {
  return {
    heartbeatIntervalMs: 200,
    idleTimeoutMs: 1500,
    logLevel: 'debug' as LogLevel,
    security: { rejectUnauthorized: false, caPath: '' },
    defaultWorkspaceId: 'w-e2e',
  };
}

export function onDidChangeSettings(_cb: () => void) {
  return { dispose() {} };
}
