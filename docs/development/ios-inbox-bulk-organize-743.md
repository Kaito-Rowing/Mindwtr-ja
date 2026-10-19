# Native iOS Inbox Bulk Organize (Task743)

The native Inbox supports bulk organization and separate project/area creation. The shared core prepares complete saved-state witnesses and uses guarded persistence with exact request receipts for retry and cold recovery. Creating a destination does not apply the task batch; cancelling keeps a destination already saved.

Project and area offers retain data, settings, selection and draft validation without expiring merely when the display clock crosses a minute. Retrying a rejected create refreshes the open picker. The picker also snapshots lazy rows before rendering.

## Validation at integration

- Focused core creation and bulk-picker suites: 90 tests passed; core typecheck passed. Clock-boundary regressions failed before the correction; removing the authority dependency caused genuine stale-data controls to fail.
- Production Swift owner harness: 80 assertions passed. Restoring the old retry route made its regression fail.
- Independent source review passed. A normal production core bundle was built from the reviewed source.
- Historical SDK8/Install10 passed signed-build and installation-preservation checks. UI8 largest-text passed, but normal-text failed at Create with the stale offer. Final data preservation and the complete failure archive passed.
- The corrected SDK9 source packet was staged. Signing admission stopped because the existing signing keychain was locked. No corrected signed build or installation has run.

Physical native/UI retesting and scratch-copy SQL/FTS acceptance remain pending. Source integration does not mark Task743 or the overall native iOS migration complete. Retained device data must be preserved in subsequent runs; failed test identities must not be reused.
