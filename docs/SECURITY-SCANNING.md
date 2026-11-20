# Scan the source export and the actual release files locally

Run these commands from the integration source directory:

```sh
python3 -I tools/prepare-release.py --out /absolute/path/to/new-source-export
python3 -I tools/scan-release.py --root /absolute/path/to/new-source-export
python3 -I tools/scan-release.py --root /absolute/path/to/new-source-export --artifact /absolute/path/to/Chimeric.app
```

The export destination must not exist. The scanner copies only the reviewed source manifest and explicitly named artifacts into a temporary directory. It never scans the rest of the Mac, imports profiles, installs software, updates signatures, quarantines files, or uploads files to a service. It rejects artifact symlinks rather than following them outside the chosen directory. A file artifact digest is its normal SHA-256. A directory digest hashes a JSON list of sorted relative filenames and each file's SHA-256. Scan a ZIP or other archive as a file if an app bundle contains symlinks that need to be preserved.

Install Gitleaks and ClamAV through their official distributions or a trusted package manager. Update the local ClamAV signatures with `freshclam` before the release scan. This is a separate, explicit network operation. The scan command requires a signature database dated within seven days. Use `--clamav-database /absolute/path/to/database` for a separately managed database. No ClamAV daemon or remote socket is used.

The report records source and artifact digests, scanner versions, signature age, counts, and safe finding locations. It does not include matched keys or scanner diagnostics. `scanComplete` is false and the exit code is nonzero if a scanner is missing, fails, has unknown or stale signatures, or reports an unresolved finding. Review detections in a private local environment. Do not paste an unredacted scanner report into an issue.

Gitleaks runs its default rules against the source snapshot, with inherited configuration and inline suppression comments disabled. Two reviewed matches are recorded in [scan-allowlist.json](../tools/scan-allowlist.json): a synthetic error-redaction test token and a frontend input SHA-256 digest. Each exception requires the exact rule, source path, and hash of the complete source line. Changing that line requires a fresh review. No directory, file, or credential pattern is broadly excluded. The release checker separately rejects Google installed-app client IDs and client secrets so the experimental direct connection cannot publish a captured client pair.

ClamAV checks the source and the selected artifacts, including supported archives. Encrypted content and files that exceed configured extraction limits produce alerts. Gitleaks checks source files, not Git history or binary artifact contents. Semgrep is not part of this scanner: local static code analysis can be added separately using reviewed local rules, without downloading rules or uploading source during a release scan.

A successful scan means these tools found no unresolved matches in those exact bytes. It cannot prove that software is malware-free, replace code review, or close the other release gates. Keep the scan report with the release hashes and retain the pending gates in [release-status.json](../release-status.json).

## Final release-candidate scan

The 2026-11-20 scan covered the reviewed 292-file source boundary, the Mac app and ZIP, and the Linux x64 directory and tarball.

- Source boundary: 292 files. The exact SHA-256 is stored in the external scan record so the source documentation does not attempt to contain its own hash.
- Mac app directory-snapshot SHA-256: `d1c35e642b2132d5d8b658188090e4f06a1897d8cefc11f3646cb6d5f7361cb3`
- Mac ZIP SHA-256: `886ed2deaf24c934324da9b7789de23818f1456cd23ff3595c2c8a6a4f6df0c9`
- Linux x64 directory-snapshot SHA-256: `89444dab20381ff390df5722102a3557edcb5313527c1e6ea17e93b0c16148fe`
- Linux x64 tarball SHA-256: `6b2ef110486479a12a623a06fa4026305497d2afd3139d43fc74c4709cf48ea9`
- Gitleaks 8.30.1: zero unreviewed findings and two exact reviewed findings
- ClamAV 1.5.5, database 28188: zero infected files and zero errors; the exact file count is recorded externally

The record is `work/release-goal-20261120/final-release-scan.json` in the private release evidence directory. The Mac candidate passes strict local arm64 code-signature verification with an ad-hoc signature. It is not notarized. Git-history secret scanning, runtime credential isolation and redistribution rights remain separate checks.

The command formats follow the official [Gitleaks documentation](https://github.com/gitleaks/gitleaks) and [ClamAV scanning documentation](https://docs.clamav.net/manual/Usage/Scanning.html).
