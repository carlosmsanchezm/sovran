import * as net from 'net';

export type GrpcTargetOverrides = {
  sslTargetNameOverride: string;
  defaultAuthority: string;
};

function normalizeHostname(hostname: string): string {
  if (hostname.startsWith('[') && hostname.endsWith(']')) {
    return hostname.slice(1, -1);
  }
  return hostname;
}

function parseUrlHostname(urlString: string): string | undefined {
  try {
    const url = new URL(urlString);
    if (url.username || url.password) {
      return undefined;
    }
    if (url.pathname !== '/' || url.search || url.hash) {
      return undefined;
    }
    if (!url.hostname) {
      return undefined;
    }
    return normalizeHostname(url.hostname);
  } catch {
    return undefined;
  }
}

export function getGrpcTargetOverrides(endpoint: string): GrpcTargetOverrides | undefined {
  const trimmed = endpoint.trim();
  if (!trimmed) {
    return undefined;
  }

  const hostname = trimmed.includes('://')
    ? parseUrlHostname(trimmed)
    : (parseUrlHostname(`https://${trimmed}`) ?? (net.isIP(trimmed) ? trimmed : undefined));

  if (!hostname) {
    return undefined;
  }

  return {
    sslTargetNameOverride: hostname,
    defaultAuthority: hostname.includes(':') ? `[${hostname}]` : hostname,
  };
}

