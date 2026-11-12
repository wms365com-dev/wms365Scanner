# WMS365 Print Agent for Windows

The WMS365 Print Agent connects one warehouse computer to printers installed on that computer. Authorized WMS365 users can send pick tickets, packing slips, and supported labels directly to the correct warehouse printer.

The agent only makes outbound HTTPS connections to WMS365. It does not expose the computer or its printers to the internet.

## Install

1. Extract the WMS365 Print Connector ZIP on the warehouse computer.
2. Double-click `Install-WMS365.cmd`. The supported runtime is bundled; the independent PDF engine downloads from its official publisher with checksum verification.
3. Allow installation to finish. No separate Node.js installation is needed.
4. The local setup screen opens automatically at http://127.0.0.1:8765.

The installer does not require administrator access. It creates a desktop shortcut and starts the agent automatically when the current Windows user signs in.

## Connect a warehouse

1. Sign in to the local connector using your normal WMS365 warehouse email and password.
2. Choose a warehouse from your authorized warehouse list.
3. Select **Connect This Computer**.
4. No password is saved; the temporary session is discarded and the station credential is encrypted for this Windows user.
5. The computer is registered automatically in WMS365 warehouse printing settings.
6. Select the local **Letter-size document printer**.
7. Select the local **Label printer**.
8. Save the printer choices and test each printer.
9. Use document-specific overrides where a document needs a different printer from the default.

A print station is assigned to one fulfillment location and its enrolling user. Every job claim rechecks current user activity, warehouse permissions, and allowed customer accounts. **Sign Out** revokes this station and disables its registered printers.

## Daily use

The agent runs quietly in the background. In WMS365, use the warehouse print action for:

- Pick tickets
- Packing slips
- UCC128 / GS1-128 labels
- BOLs on staged orders

The agent supports letter/label defaults and eight document-specific overrides. Other categories can be configured locally but require their WMS queue-producing workflows; choosing a printer does not add a missing document generator. Windows USB and network printers must have installed drivers; physical compatibility must be checked per device.

The local screen shows connection state, warehouse assignment, installed printers, the last WMS check, and the last printed document.

## Print reliability

- Each job has a WMS365 job ID and completion history.
- A durable receipt is saved before submission. An interrupted or ambiguous submission requires a person to inspect the printer before requesting a new copy.
- If the network fails while confirming completion, the same job is acknowledged later without printing a second copy.
- Invalid or non-PDF print payloads are rejected before reaching a printer.
- Station tokens are encrypted using Windows protection for the signed-in user and are never displayed after saving.
- The local loopback screen checks Host, Origin, and a random control secret. The cloud URL is restricted to the official WMS365 host (localhost for development).
- Legacy queue status "Printed" means the PDF engine accepted spool submission, not proof that paper physically emerged. Check jams, rolls, and offline devices physically.

## Release requirements

Requires 64-bit Windows 10/11 and internet access during installation. Runtime licensing is included in `runtime/LICENSE`. The installer downloads SumatraPDF directly from its publisher; WMS365 does not redistribute that PDF binary. License/source: https://github.com/sumatrapdfreader/sumatrapdf.

The WMS365 package is unsigned and managed computers may need IT approval. Do not disable antivirus or device security. Backend enrollment endpoints must be deployed before distributing this release for live use. Physical letter and 4x6 printer acceptance remains a release gate; simulated tests do not certify hardware.

Build using `powershell.exe -NoProfile -File print-agent/build-windows-package.ps1`; packages are written under `outputs/print-connector/`. Run `npm run test:print-agent` and the shared platform tests before release. Never create test transactions in a live customer company.

## Secure Device Connection (1.4.0)

Each enrollment proves possession of a separate ES256/P-256 computer key. JOSE is pinned to 6.2.12. Device private keys and local-screen bootstrap secrets are protected with Windows DPAPI for the current Windows user, outside the installation directory. The server binds the public-key thumbprint, enrolling user, installation UUID, warehouse and expiring credential. A stolen station token alone cannot access this device-bound connection.

Each request uses a DPoP proof following RFC 9449's signature/method/URI/token-binding checks, plus WMS365-specific exact-body SHA256 and installation binding. This is a protected print-station protocol, not a claim that WMS365 has a complete OAuth authorization server. Proofs have a 60-second clock window and one-use IDs consumed in PostgreSQL, including across multiple server instances. Server clocks must remain synchronized. Only fixed asymmetric ES256 signatures and public EC keys are accepted; no key-URL fetching or symmetric/unsigned fallback. Requests are capped at 64 KB. Tokens in URLs/JSON are rejected. Current user activity, permissions, company assignments and active warehouse access are rechecked on every request; the local agent stops retrying revoked credentials until reauthorization.

The local screen is locked until opened using the Windows-user-protected desktop shortcut. An HttpOnly, SameSite=Strict loopback cookie plus request control secret protects local actions; no credential or control secret is embedded in the unauthenticated page. HTTPS uses normal certificate validation and the exact official production origin, without disabling certificate checks or pinning Railway's rotating leaf certificate. Device-bound connection failures feed the existing access-restriction audit; secrets and PDF contents are not logged.

Credentials expire after 30 days and are rotated on re-enrollment. Sign out and sign in again before expiry; this version does not silently extend credentials. Backend support must be deployed with the additive schema before clients enroll. Older unbound stations fail closed by default; PRINT_CONNECTOR_ALLOW_LEGACY_TOKENS=true is a temporary, explicitly insecure transition option only, never a fallback for key-bound devices. Keep it disabled for normal operation. PRINT_CONNECTOR_AUTH_ORIGIN is only for a trusted localhost development environment; production remains https://app.wms365.co.

DPAPI is software-protected storage, not TPM-backed non-exportable keys. These protections do not defend a compromised Windows account, local administrator, browser profile or server. Production rollout still requires Windows code signing, controlled updater-key recovery, edge abuse/rate-limit monitoring, a physical printer pilot and post-deployment acceptance checks. Test transactions must only use the designated test company; all automated tests here use isolated files and mocked databases.

## Over-the-air updates

Version 1.3.0 adds hourly automatic checks and **Check for Updates** in the local connector. Updates wait for active printing and local actions to finish, then pause new print claims. A signed release announcement and exact package checksum are verified before installation. Printer assignments, encrypted station credentials, receipt history, the PDF engine, and startup shortcuts are preserved. The connector restarts and checks its version and process health; startup failure restores the previous installation. A failed release is blocked from repeatedly reinstalling. Backup folders and `wms365-update-status.json` are retained beside the installation for support.

Release activation requires an owner-controlled Ed25519 signing key. Keep its private key outside the repository and public web folder, preferably in a controlled signing service. Build the initial installer with `-UpdatePublicKeyFile OWNER_PUBLIC_KEY.pem`; the public key is pinned in the installation. Packages built without that key clearly report that OTA is not configured. Key rotation requires a separately approved installer; it is never accepted silently from an update download.

`provision-update-signing-key.js` provisions/reuses a Windows-encrypted owner key under `%LOCALAPPDATA%\WMS365 Release Signing` and exports only its public key into the project. The build picks up that public key automatically. Signing accepts the protected key file without displaying the private key. This key is tied to the current Windows user/machine: production release management must arrange controlled key recovery or a managed signing service before wider distribution. Never commit private key files or upload them to the release folder.

Sign a finished package with `node print-agent/sign-update-release.js ZIP VERSION HTTPS_PACKAGE_URL PRIVATE_KEY_FILE stable.json`. Publish packages under `https://app.wms365.co/print-connector/releases/`, then publish the signed `stable.json` last. Configure `PRINT_CONNECTOR_RELEASE_DIR` on the server to a dedicated durable public release directory containing only signed announcements and versioned installation ZIPs. This directory must never contain credentials or business documents. Server deployment and signing-key provisioning are required before live OTA works. Renew announcements before their 90-day expiry. Publish to a pilot computer and test letter/thermal printing before making a release available to all computers; this first implementation has one stable channel, not percentage-based rollout.

The earlier 1.2.0 installer has no updater and needs one manual upgrade to this OTA-capable installation. OTA never creates or changes warehouse transactions. Cloud enrollment must still pass current warehouse/customer permissions after any update.

## Uninstall

Run `uninstall-windows.ps1` from the installed folder:
Select **Sign Out** to revoke the connection first, then **Quit** to close the program. Use **Quit** before installing an update too.

`%LOCALAPPDATA%\WMS365 Print Agent`

Local settings and print receipts are preserved by default. To remove them too:

```powershell
.\uninstall-windows.ps1 -RemoveData
```

## Support

Email support@wms365.co with the print station name, warehouse, computer name, and the error shown on the local screen. Do not email the station token.
