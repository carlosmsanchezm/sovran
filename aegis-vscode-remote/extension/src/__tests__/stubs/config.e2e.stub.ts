export type LogLevel = 'info' | 'debug' | 'trace';

export function getSettings() {
  return {
    platform: {
      grpcEndpoint: 'platform-e2e.localtest.me:8081',
      namespace: 'default',
      authScope: 'aegis-platform',
      projectId: 'p-e2e',
    },
    auth: {
      authority: 'https://keycloak.localtest.me/realms/aegis',
      clientId: 'vscode-client',
      redirectUri: 'vscode://aegis.aegis-remote/auth',
      scopes: ['openid', 'profile', 'email', 'offline_access'],
      prompt: '',
    },
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
