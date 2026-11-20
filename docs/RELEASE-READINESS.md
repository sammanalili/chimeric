# Release readiness for 0.3.0-rc.1

Current status: unreleased release candidate. The source boundary, clean-export regression suite, designated Mac-candidate startup and persistence check, strict local code-signature check, and exact frozen-source and artifact security scan passed. The remaining gates below prevent a general release claim.

## The frozen source and clean export pass their checks

- The development tree passed 964 Bun tests, with 5,982 assertions across 96 files and no failures.
- The development tree passed 61 Python tests with no failures.
- The final clean source export contains 292 selected files at the reviewed boundary.
- The clean export passed 901 Bun tests, with 5,254 assertions across 96 files and no failures. Sixty-three tests that require separately supplied native runtime or asset fixtures skipped as expected.
- The clean export ran 61 Python tests successfully. Four tests that require excluded native fixtures skipped as expected.
- `python3 -I tools/release_check.py` passed in strict mode on the clean export.

These results establish the selected source boundary and its portable regression behavior. They do not establish runtime redistribution rights or the behavior of every packaged platform.

## The designated Mac candidate starts and preserves its seeded state

The designated candidate is `work/release-goal-20261120/macos-rc-resource-wired17/Chimeric.app`.

- The isolated fresh-profile verifier passed.
- It made no provider requests and did not invoke an official model client.
- A fresh profile reported no configured Google OAuth client.
- The immediately preceding candidate contained one seeded project, nine frames, 21 artifacts and 21 artifact versions. A stop and restart preserved all four counts, with zero seed errors.
- `codesign --verify --deep --strict` passed for the arm64 bundle.
- The signature is local and ad hoc. The app is not notarized.

This proves basic fresh-profile startup and persistence of the seeded database state. It does not yet prove a complete backup/restore cycle or a real research-tool-to-artifact round trip.

## The exact source and four release artifacts pass the recorded local scan

The final scan record is `work/release-goal-20261120/final-release-scan.json`. It is stored outside the source tree so the report can record the exact source hash without changing that hash.

- Source boundary: 292 files. Its exact SHA-256 is recorded outside the source tree in the scan record, avoiding a self-referential hash.
- Mac app directory snapshot: SHA-256 `d1c35e642b2132d5d8b658188090e4f06a1897d8cefc11f3646cb6d5f7361cb3`.
- Mac ZIP: SHA-256 `886ed2deaf24c934324da9b7789de23818f1456cd23ff3595c2c8a6a4f6df0c9`.
- Linux x64 directory snapshot: SHA-256 `89444dab20381ff390df5722102a3557edcb5313527c1e6ea17e93b0c16148fe`.
- Linux x64 tarball: SHA-256 `6b2ef110486479a12a623a06fa4026305497d2afd3139d43fc74c4709cf48ea9`.
- Gitleaks 8.30.1: zero unresolved findings and two exact reviewed findings.
- ClamAV 1.5.5 with database 28188: zero infected files and zero scan errors. The exact scanned-file count is in the external record.

The two reviewed Gitleaks matches are exact allowlisted synthetic or non-credential constants. The release checker separately rejects Google installed-app OAuth client IDs and client secrets. The scan does not inspect Git history or prove that the app is malware-free.

## Brand and language evidence is partial

The build rewrites the checked app-owned product strings in the native runtime, web interface, seed prompts, bundled bio-tools user agent and compute warning. Focused tests enforce those boundaries. The Mac scan covers the rebuilt wired17 bytes. The final gate remains partial because an exhaustive signed-out page, every error state, every documentation link and every Japanese screen has not been checked as one packaged walkthrough.

## Linux evidence remains partial

The prior Linux x64 package matched its recorded hashes on Ubuntu 24.04 x86_64. The native runtime and Antigravity helper executed, and the version command returned the expected versions. Daemon startup then stopped because the host AppArmor policy denied bubblewrap an unprivileged user namespace before the service opened.

The final rebuilt Linux x64 candidate is `work/release-goal-20261120/linux-rc-current4`. Its source-focused tests, portable packaging tests, branding checks, Gitleaks scan and ClamAV scan passed. The pinned native ELF is unchanged from the Ubuntu check, but the rebuilt JavaScript runtime, asset tree and Antigravity helper were not rerun on that host.

That evidence does not prove research execution, artifacts, persistence, restore, sandbox denials, Docker or WSL. The complete Linux harness remains open.

## Open release gates

| Gate | Current state | Evidence still required |
| --- | --- | --- |
| Full restore and research round trip | Partial | Back up and restore a populated packaged profile, then run a real research tool that creates and reopens an artifact |
| Packaged credential isolation | Open | Prove at the OS boundary that research execution cannot read provider keys, refresh tokens or private authentication files |
| Mac notarization | Open | Sign with the release identity, notarize the exact distributable and verify Gatekeeper acceptance |
| Protected research | Disabled | Prove credential-bearing paths, durable kernel history and all required execution consumers together before enabling Class 2 |
| Managed converters | Open | Verify portable PDF, Office, OCR and image converters with bounded resources and clear installation failure behavior |
| Linux full harness and Docker | Partial | Start the final Linux service and verify research execution, artifacts, persistence, restore, approvals and sandbox denials in native Linux and Docker |
| WSL | Open | Repeat the supported install, startup, research, persistence and sandbox checks in WSL2 |
| Linux arm64 and claimed architectures | Open | Run the accepted suite on every claimed CPU and operating-system target |
| Voice portability | Open | Verify dictation using documented, packaged or installable dependencies without a private machine-specific environment |
| Brand and Japanese walkthrough | Partial | Check every packaged signed-out state, error page, help link and Japanese settings/session path |
| Runtime distribution rights | Review required | Establish the applicable rights for the preserved runtime and every bundled upstream component; see [DISTRIBUTION.md](DISTRIBUTION.md) |
| Final release audit | Open | Review the frozen source export, candidate hashes, notices, private-path exclusions and user-facing claims together |

New Chimeric source is selected for Apache License 2.0. That selection does not relicense the preserved runtime or upstream components.
