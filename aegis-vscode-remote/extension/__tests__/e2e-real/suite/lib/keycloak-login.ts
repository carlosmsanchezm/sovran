import { authenticator } from 'otplib';

type LoginResult = {
  redirectUri: string;
};

type LoginOptions = {
  username: string;
  password: string;
  totpSecret?: string;
  loginTimeoutMs?: number;
};

class SimpleCookieJar {
  private readonly store = new Map<string, string>();

  add(header: string): void {
    const [pair] = header.split(';', 1);
    if (!pair) {
      return;
    }
    const eq = pair.indexOf('=');
    if (eq <= 0) {
      return;
    }
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (name) {
      this.store.set(name, value);
    }
  }

  header(): string {
    return Array.from(this.store.entries())
      .map(([name, value]) => `${name}=${value}`)
      .join('; ');
  }
}

async function fetchWithCookies(url: string, init: RequestInit, jar: SimpleCookieJar): Promise<Response> {
  const headers = new Headers(init.headers ?? {});
  const cookieHeader = jar.header();
  if (cookieHeader) {
    headers.set('cookie', cookieHeader);
  }

  const response = await fetch(url, {
    ...init,
    headers,
    redirect: 'manual',
  });

  const headerAccessor = response.headers as unknown as { getSetCookie?: () => string[] };
  const setCookies = headerAccessor.getSetCookie?.();
  if (Array.isArray(setCookies) && setCookies.length > 0) {
    for (const cookie of setCookies) {
      jar.add(cookie);
    }
  } else {
    const raw = response.headers.get('set-cookie');
    if (raw) {
      jar.add(raw);
    }
  }

  return response;
}

function sliceFormHtml(markup: string, startIndex: number): string {
  const closeIndex = markup.indexOf('</form', startIndex);
  if (closeIndex === -1) {
    return markup.slice(startIndex);
  }
  return markup.slice(startIndex, closeIndex);
}

function parseForm(markup: string, baseUrl: string): { actionUrl: string; inputs: Record<string, string> } {
  const formMatch = markup.match(/<form[^>]*action=["']([^"']+)["'][^>]*>/i);
  if (!formMatch) {
    throw new Error('Failed to locate Keycloak form action.');
  }
  const actionUrl = new URL(formMatch[1], baseUrl).toString();
  const startIndex = formMatch.index ?? 0;
  const formHtml = sliceFormHtml(markup, startIndex);

  const inputs: Record<string, string> = {};
  const inputRegex = /<input[^>]*name=["']([^"']+)["'][^>]*>/gi;
  let match: RegExpExecArray | null;
  while ((match = inputRegex.exec(formHtml)) !== null) {
    const name = match[1];
    const valueMatch = match[0].match(/value=["']([^"']*)["']/i);
    inputs[name] = valueMatch ? valueMatch[1] : '';
  }
  return { actionUrl, inputs };
}

function buildFormData(inputs: Record<string, string>, overrides: Record<string, string>): URLSearchParams {
  const data = new URLSearchParams();
  for (const [name, value] of Object.entries(inputs)) {
    const override = overrides[name];
    if (override !== undefined) {
      data.set(name, override);
      continue;
    }
    data.set(name, value ?? '');
  }
  for (const [name, value] of Object.entries(overrides)) {
    data.set(name, value);
  }
  return data;
}

function generateTotpCode(rawSecret: string): string {
  const normalized = rawSecret.replace(/\s+/g, '').trim();
  if (!normalized) {
    throw new Error('TOTP secret is empty after trimming.');
  }
  try {
    const token = authenticator.generate(normalized);
    return token.padStart(6, '0');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to generate TOTP code: ${message}`);
  }
}

export async function performKeycloakLogin(authUrl: string, opts: LoginOptions): Promise<LoginResult> {
  const {
    username,
    password,
    totpSecret,
    loginTimeoutMs = 120_000,
  } = opts;

  const deadline = Date.now() + Math.max(loginTimeoutMs, 30_000);
  const jar = new SimpleCookieJar();

  let response = await fetchWithCookies(authUrl, { method: 'GET' }, jar);
  if (response.status !== 200) {
    throw new Error(`Failed to load Keycloak login page (HTTP ${response.status}).`);
  }
  let body = await response.text();
  let form = parseForm(body, response.url ?? authUrl);
  const loginData = buildFormData(form.inputs, {
    username,
    password,
    credentialId: '',
  });

  response = await fetchWithCookies(form.actionUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: loginData.toString(),
  }, jar);

  const submitTotpChallenge = async (html: string, sourceUrl: string): Promise<Response> => {
    if (!totpSecret) {
      throw new Error('Keycloak is prompting for TOTP, but AEGIS_TEST_TOTP_SECRET is not set.');
    }
    const { actionUrl: totpActionUrl, inputs: totpInputs } = parseForm(html, sourceUrl);
    const fieldName = 'otp' in totpInputs ? 'otp' : 'totp' in totpInputs ? 'totp' : undefined;
    if (!fieldName) {
      throw new Error('Unable to identify TOTP input field on Keycloak challenge page.');
    }
    const otp = generateTotpCode(totpSecret);
    const totpData = buildFormData(totpInputs, { [fieldName]: otp });
    return fetchWithCookies(totpActionUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: totpData.toString(),
    }, jar);
  };

  let totpAttempts = 0;

  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (Date.now() > deadline) {
      throw new Error('Timed out waiting for Keycloak to issue redirect.');
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) {
        throw new Error('Keycloak redirect missing Location header.');
      }
      const absolute = new URL(location, response.url ?? authUrl).toString();
      if (absolute.startsWith('vscode://')) {
        return { redirectUri: absolute };
      }
      response = await fetchWithCookies(absolute, { method: 'GET' }, jar);
      if (response.status === 200) {
        body = await response.text();
        if (/name=["']otp["']/.test(body) || /name=["']totp["']/.test(body)) {
          if (totpAttempts >= 3) {
            throw new Error('Exceeded maximum attempts submitting Keycloak TOTP challenge.');
          }
          totpAttempts += 1;
          response = await submitTotpChallenge(body, response.url ?? absolute);
          continue;
        }
        if (/id=["']kc-form-login["']/.test(body)) {
          throw new Error('Keycloak login failed. Verify username/password credentials.');
        }
      }
      continue;
    }

    if (response.status === 200) {
      body = await response.text();
      if (/name=["']otp["']/.test(body) || /name=["']totp["']/.test(body)) {
        if (totpAttempts >= 3) {
          throw new Error('Exceeded maximum attempts submitting Keycloak TOTP challenge.');
        }
        totpAttempts += 1;
        response = await submitTotpChallenge(body, response.url ?? authUrl);
        continue;
      }
      if (/window\.location\.href\s*=\s*"(vscode:[^"]+)"/.test(body)) {
        const redirect = body.match(/window\.location\.href\s*=\s*"(vscode:[^"]+)"/);
        if (redirect?.[1]) {
          return { redirectUri: redirect[1] };
        }
      }
      const metaRefresh = body.match(/http-equiv=["']refresh["'][^>]*url=([^"' >]+)/i);
      if (metaRefresh?.[1]) {
        const absolute = new URL(metaRefresh[1], response.url ?? authUrl).toString();
        if (absolute.startsWith('vscode://')) {
          return { redirectUri: absolute };
        }
        response = await fetchWithCookies(absolute, { method: 'GET' }, jar);
        continue;
      }
      if (/id=["']kc-error-message["']/.test(body) || /login-error/.test(body)) {
        throw new Error('Keycloak reported an authentication error during login.');
      }
      throw new Error('Failed to capture Keycloak redirect after login.');
    }

    throw new Error(`Unexpected Keycloak response status ${response.status}.`);
  }

  throw new Error('Exceeded redirect attempts while logging into Keycloak.');
}
