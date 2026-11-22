# Version 0.3.0-rc.9 publishes the checked integration source

This prerelease publishes Chimeric's integration source, tests, build tools and
documentation. It does not include the preserved runtime binary or a native app
installer. The full packaged release retains the open requirements below.

## Current source results are recorded with the export

[SOURCE-VERIFICATION.json](SOURCE-VERIFICATION.json) records the current source
regression tests, declared native-fixture skips and strict export checks.
`SOURCE-MANIFEST.json` records the selected file hashes. The release's
`SHA256SUMS` asset gives the checksum of the downloadable source archive.

Only the final frozen export and its named archive are covered by the current
publication scan. Older source or app scan results do not transfer to changed
bytes. Gitleaks checks credential patterns and ClamAV checks known signatures;
neither proves the absence of vulnerabilities or malicious behavior. See
[SECURITY-SCANNING.md](SECURITY-SCANNING.md) for the method and
[RELEASE-AUDIT.md](RELEASE-AUDIT.md) for the source-publication scope.

## Earlier Mac checks establish limited startup and persistence behavior

November 20–21 local Mac candidates passed isolated fresh-profile checks without
sending provider requests or invoking an official model client. One seeded
profile retained its project, frames, artifacts and versions after a stop and
restart. Those candidates also passed strict arm64 ad-hoc signature verification.
They were not notarized.

These checks establish basic startup and seeded database persistence for the
recorded candidates. They do not establish a complete backup/restore cycle,
research-tool-to-artifact round trip or the behavior of an app rebuilt from
0.3.0-rc.9. App and archive hashes remain attached to the historical verification
records rather than being presented as identities for this source release.

## Branding and Japanese coverage remain partial

The build rewrites checked app-owned strings in the native runtime, web
interface, seed prompts, bundled bio-tools user agent and compute warning.
Focused tests check those transformations. The complete packaged walkthrough
of signed-out states, errors, help links and Japanese settings and sessions
remains open. Provider names, compatibility identifiers and upstream notices
retain their meaning.

## Earlier Linux execution did not reach the research service

An earlier Linux x64 package executed its native runtime and Antigravity helper
on Ubuntu 24.04 x86_64. The version command returned the expected versions.
Daemon startup then stopped because AppArmor denied bubblewrap an unprivileged
user namespace before the service opened.

Later Linux candidates passed their recorded source-focused tests, packaging
checks and scans. Those results do not prove research execution, artifacts,
persistence, restore, sandbox denials, Docker or WSL. The final rebuilt Linux
harness must still run and pass its platform checks.

## The packaged release still needs these checks

| Gate | Current state | Evidence still required |
| --- | --- | --- |
| Full restore and research round trip | Partial | Back up and restore a populated packaged profile, then run a real research tool that creates and reopens an artifact |
| Packaged credential isolation | Open | Prove at the OS boundary that research execution cannot read provider keys, refresh tokens or private authentication files |
| Mac notarization | Open | Sign with the release identity, notarize the exact distributable and verify Gatekeeper acceptance |
| Protected research | Not approved | Prove credential-bearing paths, durable kernel history and all required execution consumers together before approving Class 2 |
| Managed converters | Open | Verify portable PDF, Office, OCR and image converters with bounded resources and clear installation failure behavior |
| Linux full harness and Docker | Partial | Start the final Linux service and verify research execution, artifacts, persistence, restore, approvals and sandbox denials in native Linux and Docker |
| WSL | Open | Repeat the supported install, startup, research, persistence and sandbox checks in WSL2 |
| Linux arm64 and claimed architectures | Open | Run the accepted suite on every claimed CPU and operating-system target |
| Voice portability | Open | Verify dictation using documented, packaged or installable dependencies without a private machine-specific environment |
| Brand and Japanese walkthrough | Partial | Check every packaged signed-out state, error page, help link and Japanese settings/session path |
| Runtime distribution rights | Review required | Establish the applicable rights for the preserved runtime and every bundled upstream component; see [DISTRIBUTION.md](DISTRIBUTION.md) |
| Full packaged-release audit | Open | Review frozen package identities, notices, private-path exclusions, protected-data evidence and user-facing claims together |

The source-publication audit is separate from the final packaged-release audit.
It can pass for the selected source export while the requirements above remain
open. [release-status.json](../release-status.json) remains the machine-readable
record of the full release gates.

Apache License 2.0 applies to eligible new Chimeric source. It does not relicense
the preserved runtime or upstream components.
