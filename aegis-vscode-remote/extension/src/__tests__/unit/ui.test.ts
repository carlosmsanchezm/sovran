import { WorkspacesProvider } from '../../ui';
import { listWorkspaces, type WorkspaceSummary } from '../stubs/platform.stub';

const listWorkspacesMock = listWorkspaces as jest.MockedFunction<typeof listWorkspaces>;

describe('WorkspacesProvider', () => {
  beforeEach(() => {
    listWorkspacesMock.mockReset();
  });

  it('includes the workspace profile in the tree item description when available', async () => {
    const previousFlag = process.env.AEGIS_EXPECT_PROFILE_DISPLAY;
    process.env.AEGIS_EXPECT_PROFILE_DISPLAY = 'true';

    listWorkspacesMock.mockResolvedValue([
      {
        id: 'workspace-123',
        name: 'workspace-123',
        cluster: 'cluster-one',
        profile: 'python-ml',
      } satisfies WorkspaceSummary,
    ]);

    try {
      const provider = new WorkspacesProvider({} as any);
      const children = await provider.getChildren();
      expect(children).toHaveLength(1);
      const item = children[0] as { description?: string };

      if (process.env.AEGIS_EXPECT_PROFILE_DISPLAY === 'true') {
        expect(item.description).toContain('profile: python-ml');
      } else {
        expect(item.description ?? '').not.toContain('profile: python-ml');
      }
    } finally {
      process.env.AEGIS_EXPECT_PROFILE_DISPLAY = previousFlag;
    }
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
});
