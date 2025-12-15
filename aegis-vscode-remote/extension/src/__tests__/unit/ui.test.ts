import * as vscode from 'vscode';
import { WorkspacesProvider, getConnectedWorkspaceId, status } from '../../ui';
import { listWorkspaces, type WorkspaceSummary } from '../stubs/platform.stub';

const listWorkspacesMock = listWorkspaces as jest.MockedFunction<typeof listWorkspaces>;

describe('WorkspacesProvider', () => {
  beforeEach(() => {
    listWorkspacesMock.mockReset();
    (vscode.env as any).remoteName = undefined;
    (vscode.workspace as any).workspaceFolders = undefined;
  });

  it('includes the workspace profile in the tree item description when available', async () => {
    listWorkspacesMock.mockResolvedValue([
      {
        id: 'workspace-123',
        name: 'workspace-123',
        cluster: 'cluster-one',
        profile: 'python-ml',
      } satisfies WorkspaceSummary,
    ]);

    const provider = new WorkspacesProvider({} as any);
    const children = await provider.getChildren();
    expect(children).toHaveLength(1);
    const item = children[0] as { description?: string };
    expect(item.description).toContain('python-ml');
  });

  it('shows status in the tree item description when available', async () => {
    listWorkspacesMock.mockResolvedValue([
      {
        id: 'workspace-789',
        name: 'workspace-789',
        cluster: 'cluster-one',
        status: 'RUNNING',
      } satisfies WorkspaceSummary,
    ]);

    const provider = new WorkspacesProvider({} as any);
    const children = await provider.getChildren();
    expect(children).toHaveLength(1);
    const item = children[0] as { description?: string };
    expect(item.description).toContain('Running');
  });

  it('shows failed status with error icon', async () => {
    listWorkspacesMock.mockResolvedValue([
      {
        id: 'workspace-failed',
        name: 'workspace-failed',
        status: 'FAILED',
      } satisfies WorkspaceSummary,
    ]);

    const provider = new WorkspacesProvider({} as any);
    const children = await provider.getChildren();
    expect(children).toHaveLength(1);
    const item = children[0] as { description?: string; iconPath?: { id?: string } };
    expect(item.description).toContain('Failed');
    expect(item.iconPath?.id).toBe('error');
  });

  it('does not append profile metadata when the platform omits it', async () => {
    listWorkspacesMock.mockResolvedValue([
      {
        id: 'workspace-456',
        name: 'workspace-456',
        cluster: 'cluster-two',
      } satisfies WorkspaceSummary,
    ]);

    const provider = new WorkspacesProvider({} as any);
    const children = await provider.getChildren();
    expect(children).toHaveLength(1);
    const item = children[0] as { description?: string };
    expect(item.description).toBe('cluster-two');
  });

  it('surfaces platform errors as actionable tree items', async () => {
    const error = new Error('platform unreachable');
    listWorkspacesMock.mockRejectedValue(error);

    const provider = new WorkspacesProvider({} as any);
    const children = await provider.getChildren();
    expect(children).toHaveLength(1);
    const item = children[0] as { label?: string; contextValue?: string };
    expect(item.contextValue).toBe('error');
    expect(item.label ?? '').toContain('platform unreachable');
  });

  it('shows an info placeholder when no workspaces exist', async () => {
    listWorkspacesMock.mockResolvedValue([]);

    const provider = new WorkspacesProvider({} as any);
    const children = await provider.getChildren();
    expect(children).toHaveLength(1);
    const item = children[0] as { label?: string; contextValue?: string };
    expect(item.contextValue).toBe('info');
    expect(item.label).toBe('No workspaces available');
  });

  it('creates a sign-in action when the platform requires authentication', async () => {
    listWorkspacesMock.mockRejectedValue(new Error('Aegis sign-in required.'));

    const provider = new WorkspacesProvider({} as any);
    const children = await provider.getChildren();
    expect(children).toHaveLength(1);
    const item = children[0] as { label?: string; contextValue?: string; command?: { command?: string } };
    expect(item.contextValue).toBe('auth');
    expect(item.label).toBe('Sign in to Aegis…');
    expect(item.command?.command).toBe('aegis.signIn');
  });

  it('creates a settings action when the platform is misconfigured', async () => {
    listWorkspacesMock.mockRejectedValue(new Error('Configure "aegisRemote.platform.grpcEndpoint" in settings.'));

    const provider = new WorkspacesProvider({} as any);
    const children = await provider.getChildren();
    expect(children).toHaveLength(1);
    const item = children[0] as { contextValue?: string; command?: { command?: string; arguments?: unknown[] } };
    expect(item.contextValue).toBe('settings');
    expect(item.command?.command).toBe('workbench.action.openSettings');
    expect(item.command?.arguments).toEqual(['aegisRemote.platform.grpcEndpoint']);
  });

  it('surfaces non-Error rejections as error items', async () => {
    listWorkspacesMock.mockRejectedValue('plain-string-error');

    const provider = new WorkspacesProvider({} as any);
    const children = await provider.getChildren();
    expect(children).toHaveLength(1);
    const item = children[0] as { label?: string; contextValue?: string };
    expect(item.contextValue).toBe('error');
    expect(item.label).toBe('plain-string-error');
  });

  it('returns a loading placeholder while in progress', async () => {
    listWorkspacesMock.mockResolvedValue([]);

    const provider = new WorkspacesProvider({} as any);
    (provider as any).loading = true;
    const children = await provider.getChildren();
    expect(children).toHaveLength(1);
    const item = children[0] as { label?: string; contextValue?: string };
    expect(item.contextValue).toBe('info');
    expect(item.label).toBe('Loading workspaces…');
  });

  it('sorts the connected workspace to the top and marks it as connected', async () => {
    (vscode.env as any).remoteName = 'aegis';
    (vscode.workspace as any).workspaceFolders = [
      { uri: vscode.Uri.parse('vscode-remote://aegis+workspace-456/') },
    ];
    listWorkspacesMock.mockResolvedValue([
      { id: 'workspace-123', name: 'workspace-123', status: 'PENDING' } as any,
      { id: 'workspace-456', name: 'workspace-456', status: 'RUNNING' } as any,
    ]);

    const provider = new WorkspacesProvider({} as any);
    const children = await provider.getChildren();
    expect(children).toHaveLength(2);
    const connected = children[0] as { label?: string; contextValue?: string; description?: string; command?: unknown };
    expect(connected.label).toBe('workspace-456');
    expect(connected.contextValue).toBe('workspace-connected');
    expect(connected.description).toBe('Connected');
    expect(connected.command).toBeUndefined();
  });

  it('assigns icons, labels, and connect commands based on status', async () => {
    listWorkspacesMock.mockResolvedValue([
      { id: 'ws-ready', name: 'ws-ready', status: 'READY' } as any,
      { id: 'ws-pending', name: 'ws-pending', status: 'PENDING' } as any,
      { id: 'ws-stopped', name: 'ws-stopped', status: 'STOPPED' } as any,
      { id: 'ws-unknown', name: 'ws-unknown', status: 'CUSTOM' } as any,
    ]);

    const provider = new WorkspacesProvider({} as any);
    const children = await provider.getChildren();
    const byLabel = new Map(children.map((item: any) => [item.label, item]));

    expect(byLabel.get('ws-ready')?.iconPath?.id).toBe('vm-running');
    expect(byLabel.get('ws-ready')?.description ?? '').toContain('Ready');
    expect(byLabel.get('ws-ready')?.command?.command).toBe('aegis.connect');

    expect(byLabel.get('ws-pending')?.iconPath?.id).toBe('sync~spin');
    expect(byLabel.get('ws-pending')?.description ?? '').toContain('Pending');
    expect(byLabel.get('ws-pending')?.command).toBeUndefined();

    expect(byLabel.get('ws-stopped')?.iconPath?.id).toBe('debug-stop');
    expect(byLabel.get('ws-stopped')?.description ?? '').toContain('Stopped');
    expect(byLabel.get('ws-stopped')?.command).toBeUndefined();

    expect(byLabel.get('ws-unknown')?.iconPath?.id).toBe('vm-outline');
    expect(byLabel.get('ws-unknown')?.description ?? '').toContain('CUSTOM');
  });
});

describe('getConnectedWorkspaceId', () => {
  beforeEach(() => {
    (vscode.env as any).remoteName = undefined;
    (vscode.workspace as any).workspaceFolders = undefined;
  });

  it('returns undefined when not in an Aegis remote context', () => {
    (vscode.env as any).remoteName = 'ssh-remote';
    expect(getConnectedWorkspaceId()).toBeUndefined();
  });

  it('extracts the workspace id from the remote authority', () => {
    (vscode.env as any).remoteName = 'aegis';
    (vscode.workspace as any).workspaceFolders = [
      { uri: vscode.Uri.parse('vscode-remote://aegis+workspace-123/home') },
    ];
    expect(getConnectedWorkspaceId()).toBe('workspace-123');
  });
});

describe('status', () => {
  it('updates the status bar text and tooltip', () => {
    const item = (status as any).item;
    const showMock = item.show as jest.Mock;

    status.set('Aegis Remote', 'connected');

    expect(item.text).toBe('Aegis Remote');
    expect(item.tooltip).toBe('connected');
    expect(showMock).toHaveBeenCalled();
  });
});
