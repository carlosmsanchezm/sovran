export async function initializePlatform() {}
export async function refreshPlatformSettings() {}

export async function issueProxyTicket(_wid: string) {
  const proxyUrl = process.env.AEGIS_TEST_PROXY_URL || 'https://127.0.0.1:7443';
  return {
    proxyUrl,
    jwt: 'e2e-jwt',
    ttlSeconds: 2,
    caPem: undefined,
    certPem: undefined,
    keyPem: undefined,
    serverName: undefined,
  };
}
