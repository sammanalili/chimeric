# The 0.3.0-rc.2 source-release audit remains open

The final audit checks whether the source release says exactly what its evidence supports. It does not convert an unverified platform candidate into a general release.

## The reviewed source boundary is explicit

`release.manifest.json` positively selects the public files, directories and build tools. The atomic exporter rejects private profiles, databases, credentials, tokens, native binaries, archives, symlinks, oversized files, unselected files and credential-shaped material. The final clean export contains 294 selected files. The strict source check and local Markdown-link check passed on that export.

The development tree passed 964 Bun tests with 5,982 assertions and 61 Python tests. The clean export passed 901 Bun tests with 5,254 assertions. Sixty-three tests that need separately supplied native fixtures skipped as declared. Its Python suite passed 61 tests with four declared fixture skips.

## The candidate identities and scans are recorded

The designated local Mac candidate is `macos-rc-resource-repl35/Chimeric.app`. Its arm64 app bundle passed strict deep code-signature verification with an ad hoc signature. It is not notarized, so Gatekeeper does not accept it as a notarized distribution.

The 2026-11-21 Mac ZIP SHA-256 is `357925befe999550dfa13bd81c5a727d8bc511a0553c7be185e37644cd83694b`. The exact app-directory and source-export hashes are kept in the private scan records to avoid a self-referential source hash. Linux artifacts are not restated as a current cross-platform release claim.

Gitleaks 8.30.1 reported no unresolved source finding. Two exact matches are documented non-secret fixtures: a synthetic error-redaction token and a frontend asset integrity digest. ClamAV 1.5.5 with database 28189 reported zero infected files and zero errors across the reviewed source, app bundle and ZIP. These scanners do not prove that the software has no vulnerability or malicious behavior.

## Licenses and notices state their actual scope

Apache License 2.0 covers eligible new Chimeric integration source. It does not relicense the preserved research runtime, recovered assets or other upstream components. `NOTICE.md`, `third-party/` and `docs/DISTRIBUTION.md` retain that distinction. Runtime redistribution remains a separate review-required gate.

## User-facing claims match the evidence

The README, installation documents, release status and release notes all identify this as a prerelease. They state that the Mac package is not notarized, Linux and WSL execution are incomplete, the runtime distribution review is open, malware scans have limited meaning, and Class 2 is unavailable. No document claims that disabled Class 2 controls make the app suitable for protected data.

## Current audit result

The final source-release audit remains open. The source boundary, notices and exclusions have been reviewed, but Class 2 is still changing and its exact packaged evidence is not frozen. The audit can pass only after those bytes, tests and claims agree. It will not authorize public redistribution of preserved runtime packages or clear unrelated platform gates.
