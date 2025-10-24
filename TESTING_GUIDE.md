# Aegis VS Code Remote - Phase 1 Testing Guide

## Prerequisites
- Docker installed and running
- VS Code installed (currently using stable, not Insiders)
- Node.js and npm installed

## Automated Real Backend Tests

Use the npm automation to provision a disposable workspace against the live Platform API and run the VS Code heartbeat suite. This flow requires no manual `kubectl` or shell scripting.

1. Export real-backend credentials:
   ```bash
   export AEGIS_GRPC_ADDR=platform.example.com:443
   export AEGIS_TEST_TOKEN=$(aws secretsmanager get-secret-value ...)
   export AEGIS_TEST_EMAIL=dev-user@example.com
   export AEGIS_PROJECT_ID=p-demo
   # Optional TLS / infra knobs
   export AEGIS_PLATFORM_NAMESPACE=default
   export AEGIS_CA_PEM=/path/to/ca.pem
   export AEGIS_TEST_CLUSTER_ID=cluster-dev
   ```
2. Install dependencies and run the suite:
   ```bash
   cd aegis-vscode-remote/extension
   npm install
   kubectl delete workspace -n aegis-workloads-local --all  # optional cleanup
   npm run test:e2e:real
   ```
3. Inspect artifacts:
   - Session JSON: `__tests__/e2e-real/.workspace-session.json`
   - CA bundle copy: `__tests__/e2e-real/workspace-ca-from-session.pem`
   - VS Code logs: `__tests__/logs-real/`

The helper retries transient provisioning failures, polls for `RUNNING` status (default timeout ≈ 8 minutes), and acknowledges/deletes the workspace on exit by calling the Platform `AckWorkload` API. Re-running the command is safe; any stale `w-vscode-e2e-*` workloads are cleaned up during startup.

---

## Setup Complete ✅

The following have been completed:
1. ✅ Docker image built (`aegis-workspace-mock`)
2. ✅ Proxy dependencies installed and SSL certificates generated
3. ✅ Proxy TypeScript compiled
4. ✅ Extension dependencies installed
5. ✅ Extension TypeScript compiled
6. ✅ Proposed API type definitions downloaded

---

## Testing Procedure

### **Step 1: Get Your VS Code Commit Hash**

This is crucial for version compatibility between the extension and the Remote Extension Host.

**Your VS Code Insiders commit hash is:**
```
9f2fcb675abc6f6de54c325ac7ec42d0a42b8326
```

(If you need to check again, run:)
```bash
"/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app/bin/code" --version | sed -n '2p'
```

---

### **Step 2: Run the Mock Workspace Container**

**In Terminal 1:**
```bash
docker run --rm --name aegis-ws --platform linux/arm64 -e VSCODE_COMMIT=9f2fcb675abc6f6de54c325ac7ec42d0a42b8326 -p 11111:11111 aegis-workspace-mock
```

**Note:** The `--platform linux/arm64` flag is required for Apple Silicon Macs.

**Expected Output:**
- The container will download VSCodium REH
- You should see `codium-server` starting and listening on port 11111
- Leave this terminal running

**What to Look For:**
- ✅ `Downloading REH vscodium-reh-linux-x64-...`
- ✅ Server starts without errors
- ❌ Download failures
- ❌ Port binding errors

---

### **Step 3: Start the WSS Proxy**

**In Terminal 2:**
```bash
cd aegis-vscode-remote/proxy
npm start
```

**Expected Output:**
```
[proxy] WSS listening on https://127.0.0.1:7001/tunnel
```

Leave this terminal running.

**What to Look For:**
- ✅ Proxy starts and listens on port 7001
- ❌ Certificate errors
- ❌ Port already in use errors

---

### **Step 4: Launch the Extension in Debug Mode**

**In Terminal 3 (or VS Code Insiders integrated terminal):**
```bash
cd aegis-vscode-remote/extension
npm run watch
```

Wait for the initial compilation to complete. You should see:
```
[time] Starting compilation in watch mode...
[time] Found 0 errors. Watching for file changes.
```

**Then in VS Code:**
1. Open the `aegis-vscode-remote/extension` folder
2. Press **F5** (or go to Run > Start Debugging)
3. A new "Extension Development Host" window will open

---

### **Step 5: Test the Connection**

**In the Extension Development Host window:**

1. Press `Cmd+Shift+P` (Mac) or `Ctrl+Shift+P` (Windows/Linux)
2. Type and select: **"Aegis: Connect"**
3. Wait for the connection to establish

---

## Success Criteria ✅

### Expected Behavior:
1. ✅ A **new VS Code window** opens after running "Aegis: Connect"
2. ✅ Bottom-left corner shows a **green remote indicator** with text **"Aegis: w-1234"**
3. ✅ File explorer shows a remote file system (initially empty or with `/home/project`)
4. ✅ You can create a new file, type content, and save it
5. ✅ Integrated terminal works:
   - Press `` Ctrl+` `` to open terminal
   - Type `echo hello` and press Enter
   - Should print "hello"

### Visual Indicators:
- **Status bar item**: Should show `$(plug) Aegis: Connected` during connection
- **Remote indicator**: Green badge in bottom-left corner

---

## Troubleshooting - Where to Find Errors

### Terminal 1 (Docker Container):
**Look for:**
- Download errors from GitHub
- Server startup failures
- Connection messages when proxy connects

**Common Issues:**
- ❌ `VSCODE_COMMIT` not set or wrong version
- ❌ Network issues downloading REH
- ❌ Port 11111 already in use

### Terminal 2 (Proxy):
**Look for:**
- WebSocket connection messages: `[proxy] WebSocket connection established`
- Data transfer logs: `[proxy] C->S: X bytes` and `[proxy] S->C: X bytes`
- Connection errors

**Common Issues:**
- ❌ Cannot connect to Docker container at `127.0.0.1:11111`
- ❌ Certificate issues
- ❌ Port 7001 already in use

### VS Code Output Panel:
**In the Extension Development Host window:**
1. View > Output
2. Select **"Aegis Remote"** from the dropdown

**Look for:**
- `[resolver] resolve(aegis+w-1234) attempt=1 url=wss://...`
- `[client] ws open wss://127.0.0.1:7001/tunnel?wid=w-1234`
- Connection status updates

**Common Issues:**
- ❌ Cannot connect to proxy at `wss://127.0.0.1:7001`
- ❌ SSL/TLS certificate errors
- ❌ WebSocket handshake failures

### VS Code Developer Tools:
**For deeper debugging:**
1. Help > Toggle Developer Tools
2. Check Console tab for errors

---

## What to Report

If you encounter errors, copy and paste the following:

1. **Error messages** from all three terminals
2. **Output from "Aegis Remote" channel** in VS Code
3. **Console errors** from Developer Tools (if applicable)
4. **Your VS Code version**:
   ```bash
   /Applications/Visual\ Studio\ Code.app/Contents/Resources/app/bin/code --version
   ```
5. **What step failed** and what you expected vs. what happened

---

## Clean Up

To stop everything:

1. **Terminal 1**: `Ctrl+C` or `docker stop aegis-ws`
2. **Terminal 2**: `Ctrl+C`
3. **Terminal 3**: `Ctrl+C`
4. Close VS Code Extension Development Host windows

---

## Next Steps

Once testing is successful, provide feedback on:
- Connection speed and stability
- Any UI/UX issues
- Feature requests or improvements
- Error messages that need better clarity
