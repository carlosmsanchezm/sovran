export type LogLevel = 'info' | 'debug' | 'trace';

export function getSettings() {
  return {
    platform: {
      grpcEndpoint: 'platform.localtest.me:8081',
      namespace: 'default',
      authScope: 'aegis-platform',
      projectId: 'p-test',
    },
    auth: {
      authority: 'https://keycloak.localtest.me/realms/aegis',
      clientId: 'vscode-client',
      redirectUri: 'vscode://aegis.aegis-remote/auth',
      scopes: ['openid', 'profile', 'email', 'offline_access'],
      prompt: '',
    },
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
