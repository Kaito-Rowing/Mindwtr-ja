# Gmail OAuth desktop prototype (#1326)

Status: implementation is for designated test accounts, not general availability. Mobile is out of scope. Release builds do not enable Gmail unless the maintainer explicitly supplies the verified-production build configuration after completing the gates below. IMAP remains available independently.

## Registration and local test setup

1. Create/select a Google Cloud project owned by Mindwtr and enable Gmail API.
2. Configure Google Auth Platform Branding (Mindwtr, support and developer contacts); Audience External, publishing status Testing, explicitly designated test users.
3. Data Access: request only `https://www.googleapis.com/auth/gmail.readonly`.
4. Create a Desktop app OAuth client and save its installed-client JSON outside the repository. If Google no longer offers a download for an existing client, use Add secret and immediately save the client ID and new secret in an `installed` object with `client_id` and `client_secret` fields; retain the existing secret during testing. Do not use a Web client, an embedded login webview, OAuth IMAP, or a Mindwtr-hosted callback.
5. Set `MINDWTR_GMAIL_OAUTH_CLIENT_FILE` to the absolute JSON path when launching a debug desktop build. The release build does not accept this runtime override. The JSON contains client registration metadata, not a mailbox access/refresh token; distributed desktop client secrets are not confidential credentials and never replace PKCE.
6. Use an isolated Mindwtr test profile and disposable messages in a designated Gmail account. Create a label in Gmail, for example Mindwtr, and assign a few test messages. Creating/renaming labels remains a Gmail action.
7. In Settings → Integrations → Email capture, connect Gmail through the system browser, verify the returned account, select a label, then explicitly start capture. Merely connecting or highlighting a label imports nothing.

Testing-mode Gmail refresh tokens generally expire after seven days; that is not an acceptable production deployment configuration.

## Data flow and ownership

- Authorization is system-browser code flow with S256 PKCE, random state and a bounded one-shot IPv4 loopback callback. Callback requests must match the method, host, path and state. Cancelling or starting another connection invalidates the old attempt.
- Only the Rust host sees access/refresh tokens. They live in the OS credential store (or the existing encrypted Flatpak Secret portal store), scoped to the app and local configuration path. No plaintext credential fallback; portable/locked/unavailable secure storage fails closed. Tokens never enter frontend responses, task data, ordinary backups/exports, or synchronized settings.
- Gmail profile and label/message reads go directly from the desktop to fixed Google HTTPS endpoints. No mailbox proxy or Mindwtr account is introduced. Gmail requests do not send mail, modify flags, add/remove labels, or delete messages.
- The selected label is an application filter. Google grants read access to the mailbox, not to that label alone. The pre-connect UI explains this distinction.
- Sender, subject and bounded body text become normal Inbox tasks via the existing email builder and core capture factory. File attachments are not imported. Capture requires a complete supported body response before acknowledgement; it does not replace an unavailable body with a snippet and claim success.
- Imported content subsequently follows existing task storage, user-configured sync, backup/export and optional AI paths. Disconnect does not erase these tasks, remote copies or exports. Users delete tasks and retained backups separately. The pre-connect disclosure must name these destinations; existing AI settings and consent still apply.
- Analytics and diagnostics carry aggregate outcomes only. OAuth codes, authorization URLs, tokens, account addresses, label names, identifiers and message contents must not be logged.

## Duplicate prevention and races

Task identity is deterministic from the canonical Gmail profile address digest and Gmail message ID, independent of label. A reconnect to the same mailbox or a second device capturing it creates the same task IDs; the normal sync merge converges those IDs and replay does not overwrite an existing task or tombstone. A different account has a different identity. A Workspace account address rename changes this prototype identity; it must be treated as a different account until a stable-subject migration is designed.

Device-private receipts retain acknowledged opaque account/message IDs across disconnect and label changes, without a finite recent-ID window. Receipt storage is not task data and does not sync. Corrupt/unreadable state fails closed rather than resetting dedupe. Capture commits the receipt only after task persistence succeeds. Failed saves can replay with the same deterministic IDs and preserve edits. If both the task/tombstone and private receipts have been purged or the device profile reset, old labelled messages may be captured again; remove their capture label to avoid that intentional reset case.

Polling is bounded and read-only. A batch is bound to its connection generation, account, label and page. Config changes, disconnect, cancellation and reconnect invalidate stale batches and pending OAuth/refresh completions. The frontend checks this authority again inside the shared writer gate immediately before task creation. A save already admitted before disconnect can finish; later batches cannot start. Native acknowledgement validates the issued batch rather than trusting caller-supplied IDs. Pagination advances only on acknowledgement, including pages containing previously acknowledged mail.

Disconnect first disables capture durably, then removes device credentials and attempts Google token revocation. If Google cannot confirm revocation, the UI directs the tester to Google Account permissions; offline disconnect must still stop local polling. Disconnecting one client can revoke the shared Google app grant and require reconnect on another device; it never deletes previously captured tasks.

## Required production gate — still open

Do not set compiled `MINDWTR_GMAIL_PRODUCTION_VERIFIED=1` or distribute a broadly enabled client until all of these have evidence:

- Mindwtr-owned Google project/client, verified domain ownership and matching app branding, support contact, homepage and public privacy disclosures.
- Restricted `gmail.readonly` scope justification and a demonstration showing consent, label filtering, capture, reconnect and disconnect. Submit the actual desktop flow for Google's restricted-scope verification or document an applicable exception.
- A review of the complete derived-data flow: every supported user sync provider (including self-hosted Cloud and CloudKit), app backups/exports, diagnostics/feedback, and every optional remote AI provider. Determine permitted use, consent, retention/deletion and provider training terms for email-derived data. Do not assume local token storage exempts downstream content transfers.
- Confirm security-assessment applicability with Google for this actual flow. Google distinguishes local-only access from restricted data stored/transmitted through servers; neither “all desktop apps need an annual assessment” nor “local tokens always exempt us” is a valid shortcut.
- Final public privacy wording and the required affirmative Limited Use disclosure. No sale, ads, unrelated model training or unrelated human access. Resolve any incompatible optional provider/data path before enabling it for Gmail-derived data.
- Production publishing status and valid refresh-token lifecycle; Testing status and seven-day tokens are prototype-only.
- Native browser/loopback and secure-storage acceptance on supported desktop channels (Linux/Flatpak, macOS, Windows), using designated accounts. Source/unit coverage is not live Google consent evidence.

Compiled client settings: `MINDWTR_GMAIL_CLIENT_ID`, `MINDWTR_GMAIL_CLIENT_SECRET` (public desktop metadata) and the production-verification gate. There is no end-user client-secret field or global account requirement.

## Evidence required before calling the prototype accepted

Connect → label selection → capture → app restart → reconnect → disconnect. Check no mail/labels changed; saved tasks survive and checks do not duplicate them. Exercise consent denial, stale callback, cancellation, expired/revoked access, offline failure, failed task persistence and two clients with one mailbox. Confirm no token appears in task export, synchronized payload or diagnostics. Test account switching while a batch waits for the actual shared writer gate. Keep failures and limits in the task handoff, not fabricated success claims.

## Primary references (checked 2026-10-20)

- [Desktop OAuth and PKCE](https://developers.google.com/identity/protocols/oauth2/native-app)
- [Gmail scopes](https://developers.google.com/workspace/gmail/api/auth/scopes)
- [Restricted-scope verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification)
- [Workspace user-data policy and Limited Use](https://developers.google.com/workspace/workspace-api-user-data-developer-policy?hl=en)
- [Refresh-token expiry](https://developers.google.com/identity/protocols/oauth2#expiration)
- [Read-only message listing](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/list)
