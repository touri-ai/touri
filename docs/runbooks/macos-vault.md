# macOS vault access across updates

If a saved login stops working after installing an update, open that bot and click **Permitir acesso ao cofre** (English: **Allow vault access**). In the macOS dialog, choose **Permitir sempre** (**Always Allow**). macOS may ask for the login keychain password. The app checks again and resumes the message you already tried to send, once. Cancelling leaves the draft editable. Doctor offers the same action for each affected login; terminal alternatives are inside **Outras opções**.

Saved browser sessions have their own per-bot key. If that key needs approval, open **Diagnóstico**, find **Navegador · [bot name] · sessão salva**, click **Permitir acesso ao cofre**, then choose **Permitir sempre**. Doctor checks again automatically; retry opening the bot's browser to restore its saved cookies and storage. A denied, cancelled or timed-out read leaves the existing encrypted file and its key untouched. The browser does not create an empty context for an unreadable saved session. New saves require encryption; legacy unencrypted session files remain readable and are encrypted on the next successful save.

Native recovery is offered only by desktop macOS. Linux and headless hosts show guidance to check the server data folder's permissions and restart the touri service, along with **Verificar de novo** in chat. They never invoke the macOS authorization command or suggest replacing a saved login while the vault is unavailable.

Normal vault operations disallow system interaction and have a two-second native deadline. Authorization is a separate foreground app command, with a 90-second deadline. The secret never returns to the webview. The Security.framework call cannot be forcibly cancelled; a timed-out call retains the single operation slot until it finishes, so retries cannot accumulate native calls. Close a pending system dialog before trying again.

## Stable signing for local builds

Ad-hoc signing (`-`) produces a designated requirement containing the executable's code hash. Rebuilding changes it. The file-based login keychain's default item ACL trusts the creating application's designated requirement, so a new hash requires authorization again. A stable certificate and bundle identifier preserve that requirement across rebuilds. We keep the default ACL: no allow-all access, identifier-only requirement, shared partition list, or broad access group.

Create a dedicated identity once using macOS **Keychain Access > Certificate Assistant > Create a Certificate**:

1. Name: `touri Local Development`; Identity Type: **Self Signed Root**; Certificate Type: **Code Signing**. Store it in your **login** keychain. Choose a suitable validity period using the assistant's defaults override if needed.
2. Open that certificate, expand **Trust**, and set **Code Signing** to **Always Trust**. Leave other trust purposes at their defaults. macOS asks you to authorize this change. This is a local development identity, never a distribution identity.
3. Verify that `security find-identity -v -p codesigning` lists the identity as valid.
4. Run `scripts/build-macos-signed.sh`. It checks the identity before building and exports `APPLE_SIGNING_IDENTITY` only for this process and its children. For an existing distribution identity, set that environment variable before calling the script instead. Do not put certificate names containing personal information, certificates, private keys, keychain passwords, or signing configuration in git.
5. Inspect the resulting app with `codesign -d -r- path/to/touri.app`. A local certificate requirement includes the signer certificate, and a distribution requirement includes the stable signer/team and `ai.touri.desktop` identifier. Compare requirements across two builds. Do not rotate the certificate, change the identifier, or re-sign the installed app ad-hoc between builds.

Keep that certificate and private key in the login keychain and retain a secure backup according to your own local policy. Never recreate it for each build. Switching from an older ad-hoc build to the stable identity still needs the one-time vault authorization above for each previously protected item. Production releases must use a consistent distribution signing identity; unsigned releases cannot promise prompt-free access across updates.

## Disposable signature-change check

Use a unique test service such as `ai.touri.desktop.secret.update-probe`, never the production `ai.touri.desktop.secret` service. The native store accepts an explicit service for test harnesses. Write a synthetic value with build A, change its ad-hoc signature for build B, then read with interaction disabled: expect `VAULT_ACCESS_REQUIRED`, not an absent login. Bring the app to the foreground and explicitly authorize that same test item, choose **Always Allow**, and retry the normal read: expect the original synthetic value. Rebuild twice with the stable identity and verify the second build reads without another prompt. Delete only the dedicated test item when finished. Never inspect, overwrite, change ACLs on, or delete existing user items during this check.

The default designated requirement and the Keychain relationship are described in [Apple TN2206](https://developer.apple.com/library/archive/technotes/tn2206/) and [TN3127](https://developer.apple.com/documentation/technotes/tn3127-inside-code-signing-requirements).

The repository includes `src-tauri/examples/vault_update_probe.rs` for the manual check (`cargo build --manifest-path src-tauri/Cargo.toml --example vault_update_probe`). Package that executable in a disposable app bundle with its own bundle identifier. Its four buttons write, read, authorize, and remove only the dedicated test item. `--stable` switches to the separate `ai.touri.desktop.secret.stable-update-probe` service for the stable-signer comparison. The example has its own embedded test page and never starts the production sidecar or accesses the production vault service.
