import { jest } from '@jest/globals';

export type Ticket = {
  proxyUrl: string;
  jwt: string;
  caPem?: string;
  certPem?: string;
  keyPem?: string;
  serverName?: string;
  ttlSeconds: number;
};

export type WorkspaceSummary = {
  id: string;
  name: string;
  cluster?: string;
  dns?: string;
  profile?: string;
  persona?: string;
};

export const listWorkspaces = jest.fn(async (): Promise<WorkspaceSummary[]> => []);

export async function initializePlatform() {}
export async function refreshPlatformSettings() {}

export async function issueProxyTicket(wid: string): Promise<Ticket> {
  return {
    proxyUrl: process.env.AEGIS_TEST_PROXY_URL ?? 'https://127.0.0.1:7443',
    jwt: 'test-jwt',
    ttlSeconds: 0,
  };
}
