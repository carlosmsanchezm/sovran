# Compliance Roadmap

Post-implementation follow-up items required for full NIST 800-171 / CMMC L2 / IL-5 compliance. This document is tracked in version control and updated as items are resolved.

## P0 — Must Address Before Assessment

### 1. FIPS-Validated Cryptography (SC.L2-3.13.11, FedRAMP SC-13, SRG 5.2.2)

**Problem:** Node.js bundled in VS Code uses OpenSSL but NOT in FIPS mode. Extension's TLS (WSS, gRPC) uses non-validated crypto.

**Options:**
- (a) Build/distribute VS Code with Node.js `--enable-fips` and OpenSSL FIPS provider — high effort, requires custom VS Code build
- (b) Document that extension delegates all crypto to OS TLS stack, MDM enforces FIPS mode on OS (BitLocker FIPS, FileVault CoreCrypto cert #3856) — more practical

**Owner:** Security architect + platform team
**Timeline:** Before CMMC L2 assessment. Document in POA&M with mitigation (b) as interim.

### 2. PIV/CAC Authentication (FedRAMP IA-2(12), SRG 5.2.3)

**Problem:** DoD requires PKI-based auth (CAC/PIV) for interactive access to IL-4/IL-5 systems.

**What's needed:**
- Configure Keycloak X.509 client certificate authentication flow
- Test with actual CAC readers on macOS + Windows + Linux
- Document supported middleware (DoD CAC middleware, OpenSC)
- No extension code change needed — browser-based PKCE flow handles it

**Owner:** Identity/Keycloak team
**Timeline:** Before DoD pilot

### 3. System Security Plan (SSP)

**Problem:** Cannot pass CMMC L2 assessment without an SSP mapping all 110 practices.

**What's needed:** Full SSP document mapping each NIST 800-171 Rev 2 control to implementation, organizational policy, and inherited controls.

**Owner:** Compliance lead
**Timeline:** Before assessment

### 4. Password Grant Flow Build-Gating

**Problem:** `automationSessionFromEnv()` in `auth.ts` supports plaintext password grant via env vars. Disabled in secure mode, but code still ships in production.

**What's needed:** Gate behind `NODE_ENV=test` or a compile-time build flag so it is physically absent from production VSIX.

**Owner:** Extension dev team
**Timeline:** Next release

## P1 — Should Address Before Pilot

### 5. Server-Side Audit Logging (AU.L2-3.3.1, 3.3.2, 3.3.5)

**Problem:** Extension logs only to local VS Code OutputChannel. On RAM disk, logs vanish on exit = no audit trail. DFARS 252.204-7012 requires 90-day retention.

**What's needed:**
- New `auditEvent(type, metadata)` function in extension
- New gRPC RPC on Platform API: `ReportClientEvent`
- Events: login success/failure, workspace connect/disconnect, session renewal/revocation, errors
- Structured format: timestamp, user ID, device fingerprint, event type, session ID

**Owner:** Extension dev + platform API team
**Timeline:** Before production with CUI

### 6. User-Inactivity Session Timeout (AC.L2-3.1.10, AC.L2-3.1.11)

**Problem:** The 45s WebSocket idle timeout is network health, not user inactivity.

**What's needed:**
- Track user input activity (keyboard/mouse events via VS Code API)
- After configurable period (default 15 min), show "session locked" overlay and require re-auth
- In secure mode, auto-disconnect and clear session

**Owner:** Extension dev team
**Timeline:** Before production with CUI

### 7. MDM Posture Check at Connection Time (AC.L2-3.1.18, IA.L2-3.5.1)

**Problem:** Extension does not verify device is MDM-enrolled or compliant.

**What's needed:**
- Integration with MDM compliance API (Intune, Workspace ONE, etc.)
- Check at connection time: FDE enabled, patches current, EDR active
- Deny connection if non-compliant

**Owner:** Platform team + MDM admin
**Timeline:** Before production with CUI

### 8. VSIX Integrity Verification

**Problem:** Secure Launcher should verify extension hasn't been tampered with.

**What's needed:**
- Sign VSIX with code signing certificate
- Launcher verifies hash/signature before installing
- Document approved VSIX distribution channel

**Owner:** DevOps/release team
**Timeline:** Before production deployment

### 9. Dependency Vulnerability Scanning in CI

**Problem:** npm dependencies may introduce vulnerabilities.

**What's needed:**
- Add `npm audit --audit-level=high` to CI pipeline
- Add Dependabot or Renovate for automated updates

**Owner:** DevOps team
**Timeline:** Next CI improvement sprint

## Organizational Documents Required

| Document | Owner | Needed By |
|----------|-------|-----------|
| System Security Plan (SSP) | Compliance lead | Before assessment |
| Plan of Action & Milestones (POA&M) | Compliance lead | Before assessment |
| Incident Response Plan | Security team | Before pilot |
| BYOD Acceptable Use Policy | Legal/HR | Before pilot |
| Configuration Management Policy | IT/MDM admin | Before pilot |
| Risk Assessment (managed BYOD) | Security architect | Before assessment |
| Supply Chain Risk Management Plan | Security architect | Before assessment |
| Key Management Plan | Platform team | Before assessment |
| Continuous Monitoring Strategy | Security team | Before assessment |
| Personnel Security Policy | HR/Legal | Before IL-5 deployment |

## Architecture Decisions Pending

1. **Windows Secure Launcher** — BitLocker check, ImDisk or built-in RAM disk, PowerShell launcher. Assess demand first.
2. **Extension marketplace distribution** — For DoD, may need private gallery (Open VSX, Artifactory) vs public marketplace.
