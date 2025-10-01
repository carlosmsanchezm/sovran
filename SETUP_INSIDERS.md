# VS Code Insiders Setup - Enable Proposed API Globally

## Problem
The remote VS Code window doesn't inherit the `--enable-proposed-api` flag, causing the extension to fail with "no resolver installed" error.

## Solution
Enable the proposed API globally via `argv.json` so all windows (including remote) get it automatically.

---

## Step-by-Step Instructions

### 1. Create the argv.json file

**Option A: Using Terminal (Recommended)**

Copy and paste this entire command into your terminal:

```bash
mkdir -p "$HOME/Library/Application Support/Code - Insiders"
cat <<'EOF' > "$HOME/Library/Application Support/Code - Insiders/argv.json"
{
  "enable-proposed-api": ["aegis.aegis-remote"]
}
EOF
```

**Option B: Manual Creation (if terminal command fails)**

1. Open Finder
2. Press `Cmd+Shift+G` (Go to Folder)
3. Type: `~/Library/Application Support/Code - Insiders`
4. If the folder doesn't exist, create it
5. Create a new file named `argv.json` in that folder
6. Open it in TextEdit and paste:

```json
{
  "enable-proposed-api": ["aegis.aegis-remote"]
}
```

7. Save the file

### 2. Verify the file was created

```bash
cat "$HOME/Library/Application Support/Code - Insiders/argv.json"
```

Expected output:
```json
{
  "enable-proposed-api": ["aegis.aegis-remote"]
}
```

### 3. Quit all VS Code Insiders windows

- Make sure **all** Insiders windows are closed
- You can also right-click the Insiders icon in the Dock and select "Quit"

### 4. Relaunch VS Code Insiders

- Open VS Code Insiders normally (not via CLI)
- No need for the `--enable-proposed-api` flag anymore!

### 5. Verify the extension is active

1. Open Command Palette: `Cmd+Shift+P`
2. Type: **"Developer: Show Running Extensions"**
3. Look for **"Aegis Remote (MVP)"** in the list
4. Or check Output panel: View → Output → Select "Aegis Remote"
   - Should see: `Aegis Remote activated`

### 6. Test the connection

1. Ensure Docker container is running:
   ```bash
   docker run --rm --name aegis-ws --platform linux/arm64 -e VSCODE_COMMIT=9f2fcb675abc6f6de54c325ac7ec42d0a42b8326 -p 11111:11111 aegis-workspace-mock
   ```

2. Ensure proxy is running:
   ```bash
   cd aegis-vscode-remote/proxy
   npm start
   ```

3. In VS Code Insiders, press `Cmd+Shift+P`
4. Type and run: **"Aegis: Connect"**

---

## Success Indicators

### In the proxy terminal, you should see:
```
[proxy] WebSocket connection established.
[proxy] C->S: X bytes
[proxy] S->C: X bytes
```

### In VS Code Insiders:
- ✅ New remote window opens
- ✅ Bottom-left shows green indicator: **"Aegis: w-1234"**
- ✅ File explorer shows remote filesystem
- ✅ Terminal works (`` Ctrl+` ``)

---

## Troubleshooting

### If the extension doesn't activate:
- Double-check the `argv.json` file exists and has correct JSON
- Make sure you quit **all** Insiders windows before relaunching
- Check the "Aegis Remote" output channel for errors

### If you get "no resolver installed":
- The `argv.json` wasn't loaded
- Try restarting Insiders again
- Verify the file path is exactly: `~/Library/Application Support/Code - Insiders/argv.json`

### If connection fails:
- Check Docker container is running with correct commit hash
- Check proxy is running on port 7001
- Look for errors in the "Aegis Remote" output channel
