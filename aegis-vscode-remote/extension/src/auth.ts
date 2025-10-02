import * as vscode from 'vscode';

const AUTH_PROVIDER_ID = 'aegis';
const AUTH_PROVIDER_LABEL = 'Aegis Platform';
const SECRET_TOKEN_KEY = 'aegis.auth.token';
const SECRET_SUBJECT_KEY = 'aegis.auth.subject';

class AegisAuthenticationProvider implements vscode.AuthenticationProvider, vscode.Disposable {
  private sessions: vscode.AuthenticationSession[] = [];
  private readonly _onDidChangeSessions = new vscode.EventEmitter<vscode.AuthenticationProviderAuthenticationSessionsChangeEvent>();
  readonly onDidChangeSessions = this._onDidChangeSessions.event;

  constructor(private readonly context: vscode.ExtensionContext) {}

  dispose() {
    this._onDidChangeSessions.dispose();
  }

  private buildSession(token: string, subject: string | undefined, scopes: readonly string[]): vscode.AuthenticationSession {
    const sessionScopes = scopes.length > 0 ? [...scopes] : ['platform'];
    const accountLabel = subject?.trim() || 'Aegis User';
    return {
      id: 'aegis-default',
      accessToken: token,
      account: { id: accountLabel, label: accountLabel },
      scopes: sessionScopes,
    };
  }

  async getSessions(_scopes?: readonly string[], _options?: vscode.AuthenticationProviderSessionOptions): Promise<vscode.AuthenticationSession[]> {
    if (this.sessions.length === 0) {
      const stored = await this.context.secrets.get(SECRET_TOKEN_KEY);
      if (stored) {
        const subject = await this.context.secrets.get(SECRET_SUBJECT_KEY);
        this.sessions = [this.buildSession(stored, subject ?? undefined, ['platform'])];
      }
    }
    return [...this.sessions];
  }

  async createSession(scopes: readonly string[], _options?: vscode.AuthenticationProviderSessionOptions): Promise<vscode.AuthenticationSession> {
    const subject = await vscode.window.showInputBox({
      title: 'Aegis Platform Sign-in',
      prompt: 'Enter your Aegis email or username',
      placeHolder: 'you@example.com',
      ignoreFocusOut: true,
      validateInput: (value) => (value.trim().length === 0 ? 'Subject is required' : undefined),
    });
    if (!subject) {
      throw new vscode.CancellationError();
    }
    const token = await vscode.window.showInputBox({
      title: 'Aegis Platform Sign-in',
      prompt: 'Enter an Aegis Platform access token',
      password: true,
      ignoreFocusOut: true,
    });
    if (!token) {
      throw new vscode.CancellationError();
    }
    await this.context.secrets.store(SECRET_TOKEN_KEY, token);
    await this.context.secrets.store(SECRET_SUBJECT_KEY, subject.trim());
    const session = this.buildSession(token, subject, scopes);
    this.sessions = [session];
    this._onDidChangeSessions.fire({
      added: [session],
      removed: [],
      changed: [],
    });
    return session;
  }

  async removeSession(_id: string): Promise<void> {
    await this.context.secrets.delete(SECRET_TOKEN_KEY);
    await this.context.secrets.delete(SECRET_SUBJECT_KEY);
    const [removed] = this.sessions;
    this.sessions = [];
    if (removed) {
      this._onDidChangeSessions.fire({ added: [], removed: [removed], changed: [] });
    }
  }

  async clearSession() {
    await this.removeSession('aegis-default');
  }
}

let provider: AegisAuthenticationProvider | undefined;

export async function initializeAuth(context: vscode.ExtensionContext) {
  if (provider) {
    return;
  }
  provider = new AegisAuthenticationProvider(context);
  context.subscriptions.push(provider);
  context.subscriptions.push(
    vscode.authentication.registerAuthenticationProvider(
      AUTH_PROVIDER_ID,
      AUTH_PROVIDER_LABEL,
      provider,
      { supportsMultipleAccounts: false }
    )
  );
}

export async function requireSession(createIfNone = true): Promise<vscode.AuthenticationSession | undefined> {
  return vscode.authentication.getSession(AUTH_PROVIDER_ID, ['platform'], { createIfNone });
}

export async function signOut() {
  if (provider) {
    await provider.clearSession();
  }
}
