# The 0.3.0-rc.8 source publication has a separate audit

This audit distinguishes the public integration source from a packaged Chimeric
release. Publishing a checked source export does not approve native runtime
redistribution or mark the platform and protected-data requirements complete.

## The public source is selected and checked before publication

`release.manifest.json` selects the public source, tests, documentation and build
tools. The atomic exporter rejects private profiles, databases, credentials,
tokens, native binaries, archives, symlinks, oversized files and unselected files.
The strict source check also checks local Markdown links and credential patterns.

The current source regression and export results are recorded in
[SOURCE-VERIFICATION.json](SOURCE-VERIFICATION.json). That record identifies the
0.3.0-rc.8 verification scope, including declared fixture skips. Earlier test
counts and packaged-candidate scans do not describe the new source bytes.

The release's `SOURCE-MANIFEST.json` records the selected file hashes. The
`SHA256SUMS` asset beside the source archive records the archive checksum without
creating a self-referential source hash. The final scan record identifies the
exact exported bytes. The scan method is described in
[SECURITY-SCANNING.md](SECURITY-SCANNING.md).

## Prior Mac and Linux checks remain historical evidence

The November 20–21 Mac candidates passed their recorded fresh-profile startup,
seeded-state persistence and strict local code-signature checks. Their signatures
were ad hoc and they were not notarized. Recorded Gitleaks and ClamAV results
apply to those exact candidates and archives, not automatically to this source
update or a newly built app.

The earlier Linux check executed its pinned native binaries, but AppArmor stopped
namespace creation before the service opened. Source and packaging checks on
later Linux candidates do not establish a complete Linux research-harness run.
See [RELEASE-READINESS.md](RELEASE-READINESS.md) for the remaining platform work.

## Licenses and exclusions retain their scope

Apache License 2.0 covers eligible new Chimeric integration source. It does not
relicense the preserved research runtime, recovered assets or other upstream
components. [The notices](../NOTICE.md), `third-party/` and
[DISTRIBUTION.md](DISTRIBUTION.md) retain that distinction. The source download
excludes the original runtime binary and all private profiles and research data.
Runtime redistribution remains a separate review-required gate.

## Source publication does not close the packaged release audit

A source-publication decision can pass when the frozen export, its regression
results, notices, exclusions, archive checksums and user-facing claims agree.
Its measured result is recorded in
[SOURCE-VERIFICATION.json](SOURCE-VERIFICATION.json) and the release scan record.

The full packaged-release audit remains open. Class 2 requires its complete
packaged workflow and credential, storage, browser and execution boundaries to
pass together before use with protected data. Mac notarization, Linux and WSL
execution, backup/restore, managed converters and the other platform gates retain
their status in [release-status.json](../release-status.json). Source publication
cannot clear those requirements.
