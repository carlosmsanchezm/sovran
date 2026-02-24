# Getting Started with Aegis Remote for VS Code

Connect to GPU-accelerated workspaces in your Kubernetes cluster directly from VS Code. This guide walks you through installation, configuration, and your first remote session -- no DevOps experience required.

---

## What You Will Need

Before you begin, make sure you have the following:

- **VS Code Insiders** -- the standard VS Code will not work because Aegis Remote relies on preview APIs that are only available in the Insiders edition.
- **Access to an Aegis Platform deployment** -- your platform administrator will provide you with a Platform API address, a Project ID, and a Keycloak login URL.
- **A Keycloak account** -- your administrator creates this for you. It is the same username and password you use to sign into the Aegis web dashboard.

If you are missing any of these, contact your Aegis platform administrator before proceeding.

---

## Step 1: Install VS Code Insiders

Download VS Code Insiders for your operating system:

- **macOS**: https://code.visualstudio.com/insiders/
- **Windows**: https://code.visualstudio.com/insiders/
- **Linux**: https://code.visualstudio.com/insiders/

Install it like any other application. You can keep your regular VS Code installed alongside it -- they do not conflict.

After installing, open VS Code Insiders once to make sure it launches correctly.

---

## Step 2: Enable Proposed APIs

Aegis Remote uses VS Code APIs that are still in preview ("proposed APIs"). You need to tell VS Code Insiders to allow these APIs for the Aegis extension. This is a one-time setup step.

### On macOS

1. Open **Terminal** (you can find it in Applications > Utilities).
2. Copy and paste the following command, then press Enter:

```bash
mkdir -p "$HOME/Library/Application Support/Code - Insiders"
cat <<'EOF' > "$HOME/Library/Application Support/Code - Insiders/argv.json"
{
  "enable-proposed-api": ["aegis.aegis-remote"]
}
EOF
```

3. Verify the file was created by running:

```bash
cat "$HOME/Library/Application Support/Code - Insiders/argv.json"
```

You should see:

```json
{
  "enable-proposed-api": ["aegis.aegis-remote"]
}
```

### On Windows

1. Open **PowerShell** or **Command Prompt**.
2. Navigate to your user data folder and create the file:

```powershell
# PowerShell
$dir = "$env:APPDATA\Code - Insiders"
if (!(Test-Path $dir)) { New-Item -ItemType Directory -Path $dir }
Set-Content "$dir\argv.json" '{ "enable-proposed-api": ["aegis.aegis-remote"] }'
```

### On Linux

1. Open a terminal.
2. Run:

```bash
mkdir -p "$HOME/.config/Code - Insiders"
cat <<'EOF' > "$HOME/.config/Code - Insiders/argv.json"
{
  "enable-proposed-api": ["aegis.aegis-remote"]
}
EOF
```

### Important

If the `argv.json` file already exists and contains other settings, open it in a text editor and add `"enable-proposed-api": ["aegis.aegis-remote"]` as a new key in the JSON object rather than overwriting the entire file.

After creating or editing the file, **quit all VS Code Insiders windows completely** and relaunch the application.

---

## Step 3: Install the Aegis Remote Extension

Your administrator will provide you with an extension file named `aegis-remote-0.0.1.vsix`. Install it using one of these methods:

### Method A: Command Line (Recommended)

Open a terminal and run:

```bash
code-insiders --install-extension /path/to/aegis-remote-0.0.1.vsix
```

Replace `/path/to/` with the actual location of the file. For example, if you downloaded it to your Downloads folder:

```bash
code-insiders --install-extension ~/Downloads/aegis-remote-0.0.1.vsix
```

### Method B: From Inside VS Code Insiders

1. Open VS Code Insiders.
2. Open the Command Palette by pressing **Cmd+Shift+P** (macOS) or **Ctrl+Shift+P** (Windows/Linux).
3. Type **"Extensions: Install from VSIX..."** and select it.
4. Browse to the `aegis-remote-0.0.1.vsix` file and click **Install**.

After installation, you should see **"Aegis Remote (MVP)"** listed in your extensions. You can verify this by opening the Extensions sidebar (click the square icon in the left sidebar, or press **Cmd+Shift+X** / **Ctrl+Shift+X**) and searching for "Aegis".

---

## Step 4: Configure the Extension

You need to tell the extension where your Aegis Platform is running and how to authenticate. Your administrator will provide these values.

1. Open VS Code Insiders.
2. Open **Settings** by pressing **Cmd+,** (macOS) or **Ctrl+,** (Windows/Linux).
3. In the search bar at the top, type **"Aegis"**.
4. Fill in the following four required settings:

### Required Settings

| Setting | What to Enter | Example |
|---------|---------------|---------|
| **Aegis Remote > Platform: Grpc Endpoint** | The Aegis Platform API address. Your admin provides this. | `platform.aegis.example.com:443` |
| **Aegis Remote > Platform: Project Id** | Your project identifier. Your admin provides this. | `p-my-project` |
| **Aegis Remote > Auth: Authority** | The Keycloak login URL for your Aegis realm. Your admin provides this. | `https://keycloak.example.com/realms/aegis` |
| **Aegis Remote > Auth: Client Id** | The OAuth client ID for the VS Code extension. Your admin provides this. | `aegis-vscode` |

### Optional Settings

These have sensible defaults and usually do not need to be changed:

| Setting | Default | What It Does |
|---------|---------|--------------|
| **Platform: Namespace** | `default` | Namespace for workspace scoping. Change only if your admin instructs you to. |
| **Auth: Redirect Uri** | `vscode://aegis.aegis-remote/auth` | Where the browser sends you after login. Do not change unless instructed. |
| **Security: Reject Unauthorized** | Enabled | Validates TLS certificates. Your admin may ask you to disable this in development environments. |
| **Security: Ca Path** | (empty) | Path to a custom CA certificate file. Only needed if your organization uses a private certificate authority. |
| **Log Level** | `info` | Set to `debug` or `trace` if you need to troubleshoot connection issues. |

---

## Step 5: Sign In

1. Look at the **Explorer** sidebar on the left side of VS Code Insiders. You should see a section called **"Aegis Workspaces"** near the bottom. Click on it to expand it.

2. Open the Command Palette (**Cmd+Shift+P** / **Ctrl+Shift+P**) and type **"Aegis: Sign In"**, then select it.

3. Your default web browser will open to a Keycloak login page. Enter the username and password your administrator gave you.

4. After a successful login, the browser will redirect you back to VS Code Insiders. You may see a dialog asking you to allow the redirect -- click **Open** or **Allow**.

5. Back in VS Code Insiders, the **Aegis Workspaces** panel should now show your available workspaces.

---

## Step 6: Connect to a Workspace

1. In the **Aegis Workspaces** panel, you will see a list of workspaces associated with your project. Each workspace shows its name and current status (for example, "Running" or "Stopped").

2. Click on a workspace that has a **Running** status.

3. VS Code Insiders will open a **new window** connected to the remote workspace. This may take a moment the first time as VS Code sets up the remote environment.

4. Once connected, you will see:
   - The bottom-left corner of the window shows a green remote indicator with the workspace name (for example, **"Aegis: w-1234"**).
   - The File Explorer shows the file system inside the workspace.
   - The integrated terminal (**Ctrl+`**) runs commands on the remote GPU machine.

You are now coding on the GPU. Any files you create, packages you install, or scripts you run happen on the remote workspace.

---

## Common Tasks

### Viewing Workspace Status

Open the **Aegis Workspaces** panel in the Explorer sidebar to see all your workspaces and their statuses. Click the refresh icon at the top of the panel (or run **"Aegis: Refresh Workspaces"** from the Command Palette) to update the list.

### Disconnecting from a Workspace

To end your remote session:

1. Open the Command Palette (**Cmd+Shift+P** / **Ctrl+Shift+P**).
2. Type **"Aegis: Disconnect"** and select it.
3. The remote window will close and you will return to a local VS Code window.

You can also simply close the remote VS Code window.

### Reconnecting to a Workspace

If your connection drops or you disconnected earlier:

1. Open the Command Palette.
2. Type **"Aegis: Reconnect"** and select it.

This will reestablish the connection to the same workspace you were using before.

### Checking Connection Diagnostics

If you are experiencing connection issues:

1. Open the Command Palette.
2. Type **"Aegis: Show Diagnostics"** and select it.

This displays information about your current connection state, authentication status, and network connectivity that can help you or your administrator troubleshoot problems.

### Viewing Extension Logs

To see detailed logs from the extension:

1. Open the Command Palette.
2. Type **"Aegis: Show Logs"** and select it.

This opens the Output panel filtered to the Aegis Remote channel. If you need more detail, change the **Log Level** setting to `debug` or `trace` (see Step 4).

### Signing Out

1. Open the Command Palette.
2. Type **"Aegis: Sign Out"** and select it.

This clears your saved credentials. You will need to sign in again the next time you want to connect to a workspace.

---

## Troubleshooting

### "Aegis Remote requires VS Code Insiders"

**What it means**: You are running the standard edition of VS Code instead of VS Code Insiders.

**How to fix it**: Download and install [VS Code Insiders](https://code.visualstudio.com/insiders/), then open your workspace using VS Code Insiders instead of regular VS Code. The Aegis extension requires APIs that are only available in the Insiders build.

### "No resolver installed" or extension does not activate

**What it means**: The proposed APIs are not enabled for the Aegis extension.

**How to fix it**:
1. Check that the `argv.json` file exists in the correct location (see Step 2).
2. Open the file and verify it contains `"enable-proposed-api": ["aegis.aegis-remote"]` with correct JSON syntax.
3. Quit **all** VS Code Insiders windows completely and relaunch the application.
4. Open the Command Palette and run **"Developer: Show Running Extensions"**. Look for **"Aegis Remote (MVP)"** in the list.

### "Cannot reach the Aegis proxy" or connection timeout

**What it means**: The extension cannot establish a network connection to the Aegis Platform or proxy.

**How to fix it**:
1. Verify that the **Platform: Grpc Endpoint** setting is correct (see Step 4).
2. Check that you are connected to a network that can reach the Aegis Platform (for example, your corporate VPN may be required).
3. If you are behind a corporate firewall, ask your administrator whether additional ports or proxy rules need to be configured.
4. If your organization uses a private certificate authority, ask your admin for the CA certificate file and set the **Security: Ca Path** setting to point to it.

### "Authentication failed"

**What it means**: The extension could not complete the OAuth login, or your access token has expired and could not be refreshed.

**How to fix it**:
1. Run **"Aegis: Sign Out"** from the Command Palette, then run **"Aegis: Sign In"** to authenticate again.
2. Verify that the **Auth: Authority** and **Auth: Client Id** settings match the values your administrator provided.
3. Make sure your Keycloak account is active and has not been disabled. Contact your administrator if you are unsure.
4. Check that your system clock is accurate -- authentication tokens are time-sensitive.

### "No workspaces found"

**What it means**: The extension connected to the Platform API successfully but could not find any workspaces for your project.

**How to fix it**:
1. Verify that the **Platform: Project Id** setting is correct.
2. Ask your administrator to confirm that workspaces have been provisioned for your project and that your account has permission to view them.
3. Click the refresh button in the Aegis Workspaces panel to reload the workspace list.

### "Connection lost" or frequent disconnects

**What it means**: The WebSocket connection to your workspace was interrupted.

**How to fix it**:
1. Try **"Aegis: Reconnect"** from the Command Palette.
2. Check your network connection -- Wi-Fi drops and VPN reconnections are common causes.
3. If the workspace was stopped or terminated by an administrator, you will need to request a new workspace.
4. If disconnects happen frequently, run **"Aegis: Show Diagnostics"** and share the output with your administrator.

---

## Quick Reference: Commands

All commands are available through the Command Palette (**Cmd+Shift+P** / **Ctrl+Shift+P**):

| Command | What It Does |
|---------|--------------|
| **Aegis: Sign In** | Authenticate with your Keycloak account |
| **Aegis: Sign Out** | Clear saved credentials |
| **Aegis: Connect** | Connect to a workspace |
| **Aegis: Disconnect** | End the remote session |
| **Aegis: Reconnect** | Reconnect to the last workspace |
| **Aegis: Refresh Workspaces** | Reload the workspace list |
| **Aegis: Show Logs** | Open the extension log output |
| **Aegis: Show Diagnostics** | Display connection and auth diagnostics |

---

## Getting Help

- **Ask your administrator** -- they manage the Aegis Platform deployment and can help with access, credentials, and network configuration.
- **Report issues** -- if you believe you have found a bug in the extension, open an issue at https://github.com/aegis-platform/sovran/issues with the output from **"Aegis: Show Diagnostics"** and any relevant logs from **"Aegis: Show Logs"**.
- **Aegis documentation** -- visit [aegis-platform.tech](https://aegis-platform.tech) for additional platform documentation.
