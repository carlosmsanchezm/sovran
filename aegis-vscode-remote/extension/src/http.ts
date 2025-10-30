import { Agent, getGlobalDispatcher, setGlobalDispatcher } from 'undici';
import { promises as fs } from 'fs';
import type Dispatcher from 'undici/types/dispatcher';
import type { SecuritySettings } from './config';
import { out } from './ui';

let originalDispatcher: Dispatcher | undefined;
let customAgent: Agent | undefined;

async function restoreDefaultDispatcher() {
  if (customAgent) {
    try {
      await customAgent.close();
    } catch (err) {
      out.appendLine(`[http] failed to close custom dispatcher: ${String(err)}`);
    } finally {
      customAgent = undefined;
    }
  }
  if (originalDispatcher) {
    setGlobalDispatcher(originalDispatcher);
  }
}

export async function configureHttpSecurity(security: SecuritySettings): Promise<void> {
  if (!originalDispatcher) {
    originalDispatcher = getGlobalDispatcher();
  }

  out.appendLine(
    `[http] applying security settings: rejectUnauthorized=${security.rejectUnauthorized}, caPath=${security.caPath ?? ''}`
  );

  const connectOptions: Record<string, unknown> = {};
  let useCustomAgent = false;

  if (security.caPath) {
    try {
      const ca = await fs.readFile(security.caPath);
      if (ca.length > 0) {
        connectOptions.ca = ca;
        useCustomAgent = true;
        out.appendLine(`[http] loaded CA bundle (${security.caPath}) length=${ca.length}`);
      } else {
        out.appendLine(`[http] WARNING: CA bundle at ${security.caPath} was empty`);
      }
    } catch (err) {
      out.appendLine(`[http] failed to read CA bundle at ${security.caPath}: ${String(err)}`);
    }
  }

  if (security.rejectUnauthorized === false) {
    connectOptions.rejectUnauthorized = false;
    useCustomAgent = true;
    out.appendLine('[http] TLS verification disabled for HTTP requests');
  }

  if (!useCustomAgent) {
    out.appendLine('[http] using default dispatcher (no custom CA or TLS overrides)');
    await restoreDefaultDispatcher();
    return;
  }

  const previousAgent = customAgent;
  customAgent = new Agent({ connect: connectOptions });
  setGlobalDispatcher(customAgent);
  out.appendLine('[http] installed custom undici dispatcher for HTTP requests');

  if (previousAgent && previousAgent !== customAgent) {
    try {
      await previousAgent.close();
    } catch (err) {
      out.appendLine(`[http] failed to close previous dispatcher: ${String(err)}`);
    }
  }
}

export async function disposeHttpSecurity(): Promise<void> {
  await restoreDefaultDispatcher();
}

export function getHttpDispatcher(): Dispatcher | undefined {
  return customAgent;
}
