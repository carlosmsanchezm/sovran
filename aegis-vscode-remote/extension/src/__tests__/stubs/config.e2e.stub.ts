export type LogLevel = 'info' | 'debug' | 'trace';

type Security = {
  rejectUnauthorized: boolean;
  mtlsSource: 'platform' | 'system';
  caPath?: string;
};

type Settings = {
  platform: {
    grpcEndpoint: string;
    namespace: string;
    authScope: string;
    projectId: string;
  };
  auth: {
    authority: string;
    clientId: string;
    redirectUri: string;
    scopes: string[];
    prompt?: string;
  };
  heartbeatIntervalMs: number;
  idleTimeoutMs: number;
  logLevel: LogLevel;
  security: Security;
  defaultWorkspaceId: string;
};

export function getSettings(): Settings {
  return {
    platform: {
      grpcEndpoint: 'platform-e2e.localtest.me:8081',
      namespace: 'default',
      authScope: 'aegis-platform',
      projectId: 'p-e2e',
    },
    auth: {
      authority: 'https://keycloak.localtest.me/realms/aegis',
      clientId: 'vscode-extension',
      redirectUri: 'vscode://aegis.aegis-remote/auth',
      scopes: ['openid', 'profile', 'email', 'offline_access'],
      prompt: '',
    },
    heartbeatIntervalMs: 200,
    idleTimeoutMs: 1500,
    logLevel: 'debug',
    security: { rejectUnauthorized: false, mtlsSource: 'platform', caPath: '' },
    defaultWorkspaceId: 'w-e2e',
  };
}

export function onDidChangeSettings(_cb: () => void) {
  return { dispose() {} };
}
