# Explicit live integration tests

These suites mutate research sessions, plans, model selections and host-grant preferences. They remain skipped unless `CHIMERIC_LIVE_E2E=1` is set. Ordinary unit tests need no running Chimeric instance.

Use a separately started disposable fixture workspace with mock model connections and synthetic data. Provide `CHIMERIC_E2E_URL` and `CHIMERIC_E2E_SANDBOX_URL` as separate HTTP loopback origins on alternate ports. The normal app ports 18868 and 18869 are refused. `CHIMERIC_E2E_PROFILE` must be an explicit absolute directory containing a regular `.chimeric-e2e-disposable` marker file. No production profile is discovered automatically.

The historical scenarios expect seeded resource states. Set `CHIMERIC_E2E_PROJECT_ID`, `CHIMERIC_E2E_FRAME_ID`, `CHIMERIC_E2E_ARTIFACT_ID`, `CHIMERIC_E2E_REQUEST_ID`, `CHIMERIC_E2E_FORK_FRAME_ID` and `CHIMERIC_E2E_COMPLETED_FRAME_ID` to synthetic fixture resources in that profile. Some scenarios require macOS sandboxing or managed Python/R environments. These prerequisites do not establish that every historical scenario passes against every runtime revision.

Set `CHIMERIC_E2E_BINARY` and `CHIMERIC_E2E_LAUNCHER` when using a test bundle outside the standard Mac application location. The helper obtains a session specifically for the configured origin and keeps the bootstrap nonce out of errors. Run the chosen live test paths explicitly through `bun test` after fixture setup.

The isolated `tests/live-e2e-safety.test.ts` regression checks the configuration gate without contacting a runtime or reading real credentials.
