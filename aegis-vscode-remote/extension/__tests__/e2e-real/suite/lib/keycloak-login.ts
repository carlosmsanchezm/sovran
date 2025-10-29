import { chromium, Page } from 'playwright';
import { authenticator } from 'otplib';

type LoginResult = {
  redirectUri: string;
  secretUsed?: string;
};

type LoginOptions = {
  username: string;
  password: string;
  totpSecret?: string;
  deviceName?: string;
  loginTimeoutMs?: number;
};

function normalizeSecret(raw: string | undefined): string | undefined {
  if (!raw) {
    return undefined;
  }
  return raw.replace(/\s+/g, '').trim();
}

async function fillLogin(page: Page, username: string, password: string): Promise<void> {
  const userInput = page.locator('input[name="username"], input#username, input#email');
  await userInput.first().waitFor({ timeout: 15000 });
  await userInput.first().fill(username);

  const passwordInput = page.locator('input[name="password"], input#password');
  await passwordInput.first().fill(password);

  const loginButton = page.locator('input[type="submit"], button[name="login"], input#kc-login, button#kc-login');
  await loginButton.first().click();
}

async function extractTotpSecret(page: Page): Promise<string | undefined> {
  const secretContainer = page.locator('#kc-totp-secret-key, #kc-otp-secret-key');
  if (await secretContainer.count()) {
    const text = await secretContainer.first().innerText();
    const normalized = normalizeSecret(text);
    if (normalized) {
      console.warn('[keycloak-login] Detected TOTP secret on setup page:', normalized);
      return normalized;
    }
  }
  const inlineSecret = page.locator('code[data-kc-locale="otpSecret"]');
  if (await inlineSecret.count()) {
    const text = await inlineSecret.first().innerText();
    const normalized = normalizeSecret(text);
    if (normalized) {
      console.warn('[keycloak-login] Detected TOTP secret from inline code element:', normalized);
      return normalized;
    }
  }
  return undefined;
}

async function fillTotp(page: Page, secret: string, deviceName?: string): Promise<void> {
  const normalized = normalizeSecret(secret);
  if (!normalized) {
    throw new Error('TOTP secret not available for MFA step');
  }

  authenticator.options = { window: 1, step: 30, digits: 6 };
  const code = authenticator.generate(normalized);

  const totpInput = page.locator('input[name="otp"], input[name="totp"], input#kc-totp-code, input#totp');
  await totpInput.first().waitFor({ timeout: 15000 });
  await totpInput.first().fill(code);

  const deviceInput = page.locator('input[name="userLabel"], input#userLabel');
  if (await deviceInput.count()) {
    const currentValue = (await deviceInput.first().inputValue()).trim();
    if (!currentValue) {
      await deviceInput.first().fill(deviceName || 'automation-device');
    }
  }

  const totpSubmit = page.locator('input[type="submit"], button[name="login"], button#kc-totp-login, input#kc-submit, button#kc-submit');
  await totpSubmit.first().click();
}

async function maybeAcceptConsent(page: Page): Promise<void> {
  const acceptButton = page.locator('button[name="accept"], input#kc-accept, button#kc-accept');
  if (await acceptButton.count()) {
    await acceptButton.first().click();
  }
}

export async function performKeycloakLogin(authUrl: string, opts: LoginOptions): Promise<LoginResult> {
  const {
    username,
    password,
    totpSecret,
    deviceName = 'automation-device',
    loginTimeoutMs = 120_000,
  } = opts;

  let redirectUri: string | undefined;
  let secretUsed = normalizeSecret(totpSecret);

  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();

    page.on('request', (request) => {
      const url = request.url();
      if (url.startsWith('vscode://')) {
        redirectUri = url;
      }
    });

    const navPromise = page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: loginTimeoutMs }).catch(() => undefined);
    await page.goto(authUrl, { waitUntil: 'domcontentloaded', timeout: loginTimeoutMs });
    await navPromise;

    if (page.url().startsWith('vscode://')) {
      redirectUri = page.url();
    }

    if (!redirectUri) {
      try {
        await fillLogin(page, username, password);
        await page.waitForLoadState('domcontentloaded', { timeout: loginTimeoutMs }).catch(() => undefined);
      } catch (err) {
        console.error('[keycloak-login] Failed during username/password step', err);
        throw err;
      }
    }

    if (!redirectUri) {
      if (!secretUsed) {
        secretUsed = await extractTotpSecret(page) || secretUsed;
      }
      const totpPresent = await page.locator('input[name="otp"], input[name="totp"], input#kc-totp-code, input#totp').count();
      if (totpPresent > 0) {
        await fillTotp(page, secretUsed ?? '', deviceName);
        await page.waitForLoadState('domcontentloaded', { timeout: loginTimeoutMs }).catch(() => undefined);
      }
    }

    if (!redirectUri) {
      await maybeAcceptConsent(page);
      await page.waitForLoadState('domcontentloaded', { timeout: loginTimeoutMs }).catch(() => undefined);
    }

    const successDeadline = Date.now() + loginTimeoutMs;
    while (!redirectUri && Date.now() < successDeadline) {
      const url = page.url();
      if (url.startsWith('vscode://')) {
        redirectUri = url;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    if (!redirectUri) {
      throw new Error('Failed to capture vscode:// redirect from Keycloak login flow');
    }

    return { redirectUri, secretUsed };
  } finally {
    await browser.close();
  }
}
