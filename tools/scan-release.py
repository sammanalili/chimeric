"""Scan an isolated source snapshot and optional artifacts with local scanners.

No scanner installation, signature download, cloud upload, or quarantine occurs.
Only metadata is emitted. A missing, failed, or stale scanner never counts as a pass.
"""
from __future__ import annotations

import argparse
from collections import deque
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path, PureWindowsPath
import re
import shutil
import stat
import subprocess
import sys
import tempfile

# Keep Python isolated from cwd/PYTHONPATH while allowing this reviewed sibling.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from release_check import ROOT, ReleaseError, audit, selected_paths


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def scanner_environment(temporary: Path) -> dict[str, str]:
    # Do not pass provider keys or inherited scanner configuration to subprocesses.
    environment = {name: os.environ[name] for name in ('PATH', 'SYSTEMROOT', 'WINDIR') if name in os.environ}
    environment.update(HOME=str(temporary), TMPDIR=str(temporary), LANG='C', LC_ALL='C')
    return environment


def run_local(command: list[str], temporary: Path, timeout: int = 600) -> subprocess.CompletedProcess:
    return subprocess.run(command, cwd=temporary, env=scanner_environment(temporary),
                          capture_output=True, text=True, timeout=timeout, check=False)


def load_reviews(path: Path) -> list[dict]:
    rows = json.loads(path.read_text())
    if not isinstance(rows, list):
        raise ReleaseError('Secret review records must be a list')
    for row in rows:
        if (not isinstance(row, dict) or set(row) != {'path', 'rule', 'lineSha256', 'reason'}
                or not all(isinstance(value, str) and value for value in row.values())
                or not re.fullmatch(r'[a-f0-9]{64}', row['lineSha256'])
                or Path(row['path']).is_absolute() or '..' in Path(row['path']).parts):
            raise ReleaseError('Invalid secret review record')
    return rows


def classify_findings(rows: list[dict], source: Path, reviews: list[dict]) -> dict:
    """Apply only exact rule/path/source-line reviews; discard all secret fields."""
    pending, reviewed = [], 0
    for item in rows:
        file = Path(item.get('File', ''))
        if file.is_absolute():
            try:
                file = file.relative_to(source)
            except ValueError:
                raise ReleaseError('Scanner reported a file outside its source snapshot') from None
        target = source / file
        if not file.parts or '..' in file.parts or not target.is_file() or target.is_symlink():
            raise ReleaseError('Scanner reported an unrecognized source file')
        line = item.get('StartLine')
        end = item.get('EndLine')
        rule = item.get('RuleID')
        if (type(line) is not int or line < 1 or type(end) is not int or end < line
                or not isinstance(rule, str) or not re.fullmatch(r'[A-Za-z0-9_.-]{1,100}', rule)):
            raise ReleaseError('Scanner returned invalid finding metadata')
        lines = target.read_bytes().splitlines()
        if end > len(lines):
            raise ReleaseError('Scanner returned an invalid source line')
        fingerprint = digest(lines[line - 1]) if line == end else None
        if any(row['path'] == file.as_posix() and row['rule'] == rule
               and row['lineSha256'] == fingerprint for row in reviews):
            reviewed += 1
        else:
            pending.append({'path': file.as_posix(), 'line': line, 'rule': rule})
    return {'status': 'findings' if pending else 'passed', 'findingCount': len(pending),
            'reviewedFindingCount': reviewed, 'findings': pending}


def gitleaks_scan(source: Path, temporary: Path, reviews: list[dict]) -> dict:
    executable = shutil.which('gitleaks')
    if executable is None:
        return {'status': 'unavailable'}
    config = temporary / 'scanner-config.toml'
    config.write_text('[extend]\nuseDefault = true\n')
    ignore = temporary / 'scanner-ignore'
    ignore.write_text('')
    try:
        version = run_local([executable, 'version'], temporary, 15)
        result = run_local([executable, 'dir', str(source), '--config', str(config),
                            '--gitleaks-ignore-path', str(ignore), '--ignore-gitleaks-allow',
                            '--no-banner', '--no-color', '--redact=100', '--report-format', 'json',
                            '--report-path', '-', '--exit-code', '12', '--timeout', '300'], temporary, 330)
        if result.returncode not in (0, 12):
            return {'status': 'error', 'exitCode': result.returncode}
        rows = json.loads(result.stdout)
        if not isinstance(rows, list) or any(not isinstance(row, dict) for row in rows):
            return {'status': 'error', 'reason': 'invalid-report'}
        report = classify_findings(rows, source, reviews)
        if (result.returncode == 0) != (len(rows) == 0):
            return {'status': 'error', 'reason': 'inconsistent-report'}
        value = version.stdout.strip()
        report['version'] = value if re.fullmatch(r'v?\d+\.\d+\.\d+(?:[-+.][\w.-]+)?', value) else 'unknown'
        return report
    except (OSError, subprocess.TimeoutExpired, ValueError, ReleaseError):
        return {'status': 'error', 'reason': 'scanner-failed-or-invalid-report'}


def database_age(version: str) -> float | None:
    try:
        date = datetime.strptime(version.strip().rsplit('/', 1)[1], '%a %b %d %H:%M:%S %Y')
        return (datetime.now(timezone.utc) - date.replace(tzinfo=timezone.utc)).total_seconds() / 86400
    except (IndexError, ValueError):
        return None


def clamav_scan(targets: list[Path], temporary: Path, database: Path | None = None) -> dict:
    executable = shutil.which('clamscan')
    if executable is None:
        return {'status': 'unavailable'}
    # Scanner subprocesses run inside an isolated temporary directory. Resolve
    # a caller-supplied relative database before changing that subprocess cwd,
    # otherwise ClamAV silently misses a valid signature directory.
    database = database.resolve() if database is not None else None
    database_flags = ['--database', str(database)] if database else []
    try:
        version = run_local([executable, '--version', *database_flags], temporary, 30)
        age = database_age(version.stdout)
        version_text = version.stdout.strip()
        safe_version = version_text if re.fullmatch(r'ClamAV [A-Za-z0-9./: +_-]{1,180}', version_text) else 'unknown'
        metadata = {'version': safe_version, 'databaseAgeDays': round(age, 2) if age is not None else None}
        if version.returncode != 0 or age is None or age < -1 or age > 7:
            return {'status': 'database-unverified-or-stale', **metadata}
        result = run_local([executable, '--recursive', '--infected', '--scan-archive=yes',
                            '--official-db-only=yes', '--max-dir-recursion=100',
                            '--alert-encrypted=yes', '--alert-exceeds-max=yes',
                            '--follow-dir-symlinks=0', '--follow-file-symlinks=0', '--cross-fs=no',
                            '--max-filesize=2000M', '--max-scansize=4000M', '--max-recursion=32',
                            '--max-files=1000000', '--tempdir', str(temporary), *database_flags,
                            *map(str, targets)], temporary)
        counts = {}
        for label, value in re.findall(r'^(Scanned files|Infected files|Total errors):\s*(\d+)\s*$', result.stdout, re.M):
            counts[label] = int(value)
        coverage = [regular_file_counts(target) for target in targets]
        regular = sum(value['regularFileCount'] for value in coverage)
        empty = sum(value['emptyFileCount'] for value in coverage)
        # ClamAV does not count empty files as scanned. They are still copied,
        # hashed and reported; every file containing bytes must be covered.
        expected = regular - empty
        complete = (regular > 0 and 'Scanned files' in counts
                    and counts['Scanned files'] >= expected and counts.get('Total errors', 0) == 0)
        status = ('passed' if complete and result.returncode == 0 and counts.get('Infected files') == 0
                  else 'findings' if result.returncode == 1 else 'error')
        return {'status': status, 'exitCode': result.returncode, **metadata,
                'scannedFiles': counts.get('Scanned files'), 'minimumExpectedFiles': expected,
                'regularFileCount': regular, 'emptyFileCount': empty,
                'infectedFiles': counts.get('Infected files'),
                'errors': counts.get('Total errors', 0)}
    except (OSError, subprocess.TimeoutExpired):
        return {'status': 'error', 'reason': 'scanner-failed'}


def regular_file_count(root: Path) -> int:
    """Match ClamAV's follow-links=0 boundary, including a selected single file."""
    return regular_file_counts(root)['regularFileCount']


def regular_file_counts(root: Path) -> dict[str, int]:
    """Report every physical regular file and the empty subset separately."""
    counts = {'regularFileCount': 0, 'emptyFileCount': 0}
    if root.is_symlink():
        return counts
    if root.is_file():
        return {'regularFileCount': 1, 'emptyFileCount': int(root.stat().st_size == 0)}
    for parent, directories, files in os.walk(root, followlinks=False):
        directories[:] = [name for name in directories if not (Path(parent) / name).is_symlink()]
        for name in files:
            info = (Path(parent) / name).lstat()
            if stat.S_ISREG(info.st_mode):
                counts['regularFileCount'] += 1
                counts['emptyFileCount'] += int(info.st_size == 0)
    return counts


def fingerprint(value: os.stat_result) -> tuple:
    return (value.st_dev, value.st_ino, value.st_mode, value.st_size,
            value.st_mtime_ns, value.st_ctime_ns)


def copy_regular_at(directory: int, name: str, expected: os.stat_result, target: Path) -> str:
    """Open relative to the pinned directory and reject replacement or modification."""
    descriptor = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
    try:
        if not stat.S_ISREG(os.fstat(descriptor).st_mode) or fingerprint(os.fstat(descriptor)) != fingerprint(expected):
            raise ReleaseError('Artifact changed before copying a regular file')
        file_hash = hashlib.sha256()
        with os.fdopen(descriptor, 'rb', closefd=False) as incoming, target.open('xb') as outgoing:
            while True:
                chunk = incoming.read(1024 * 1024)
                if not chunk:
                    break
                outgoing.write(chunk)
                file_hash.update(chunk)
        if (fingerprint(os.fstat(descriptor)) != fingerprint(expected)
                or fingerprint(os.stat(name, dir_fd=directory, follow_symlinks=False)) != fingerprint(expected)):
            raise ReleaseError('Artifact changed while copying a regular file')
        return file_hash.hexdigest()
    finally:
        os.close(descriptor)


def artifact_inventory(directory: int, destination: Path | None = None) -> tuple[dict, list[dict]]:
    """Enumerate physical entries once, without following directory or file links."""
    entries, records = {}, []

    def walk(descriptor: int, parts: tuple[str, ...]) -> None:
        before = os.fstat(descriptor)
        entries['/'.join(parts)] = {'kind': 'directory', 'stat': fingerprint(before)}
        if len(parts) > 100:
            raise ReleaseError('Artifact directory depth exceeds scanner coverage')
        for name in sorted(os.listdir(descriptor)):
            relative = (*parts, name)
            key = '/'.join(relative)
            value = os.stat(name, dir_fd=descriptor, follow_symlinks=False)
            mode = value.st_mode
            if stat.S_ISDIR(mode):
                child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=descriptor)
                try:
                    if fingerprint(os.fstat(child)) != fingerprint(value):
                        raise ReleaseError('Artifact directory changed while opening it')
                    if destination is not None:
                        (destination / key).mkdir(mode=0o700)
                    walk(child, relative)
                    if fingerprint(os.stat(name, dir_fd=descriptor, follow_symlinks=False)) != fingerprint(value):
                        raise ReleaseError('Artifact directory changed while copying it')
                finally:
                    os.close(child)
            elif stat.S_ISREG(mode):
                entries[key] = {'kind': 'file', 'stat': fingerprint(value)}
                if destination is not None:
                    records.append({'path': key, 'kind': 'file', 'sha256': copy_regular_at(descriptor, name, value, destination / key)})
            elif stat.S_ISLNK(mode):
                target = os.readlink(name, dir_fd=descriptor)
                if fingerprint(os.stat(name, dir_fd=descriptor, follow_symlinks=False)) != fingerprint(value):
                    raise ReleaseError('Artifact link changed while reading it')
                entries[key] = {'kind': 'symlink', 'stat': fingerprint(value), 'target': target}
            else:
                raise ReleaseError('Artifact contains a nonregular file')
            if len(entries) > 1_000_000:
                raise ReleaseError('Artifact entry count exceeds scanner coverage')
        if fingerprint(os.fstat(descriptor)) != fingerprint(before):
            raise ReleaseError('Artifact directory changed during its snapshot')

    walk(directory, ())
    return entries, records


def internal_artifact_links(entries: dict) -> list[dict]:
    """Resolve against the sealed inventory, never the live filesystem or outside it."""
    links = {name: entry for name, entry in entries.items() if entry['kind'] == 'symlink'}
    for name, entry in links.items():
        target = entry['target']
        if (not target or len(target) > 8192 or '\\' in target or '\0' in target
                or target.startswith('/') or PureWindowsPath(target).drive):
            raise ReleaseError('Artifact links must have relative internal targets')
        lexical = name.split('/')[:-1]
        for part in target.split('/'):
            if part in ('', '.'):
                continue
            if part == '..':
                if not lexical:
                    raise ReleaseError('Artifact link lexically escapes its selected root')
                lexical.pop()
            else:
                lexical.append(part)

    def resolve(name: str) -> str:
        pending, resolved, followed = deque(name.split('/')), [], 0
        while pending:
            part = pending.popleft()
            if part in ('', '.'):
                continue
            if part == '..':
                if not resolved:
                    raise ReleaseError('Artifact link resolves outside its selected root')
                resolved.pop()
                continue
            candidate = '/'.join([*resolved, part])
            entry = entries.get(candidate)
            if entry is None:
                raise ReleaseError('Artifact link target is dangling')
            if entry['kind'] == 'symlink':
                followed += 1
                if followed > 40:
                    raise ReleaseError('Artifact link resolution is cyclic or exceeds its bounded depth')
                pending.extendleft(reversed(entry['target'].split('/')))
            else:
                if pending and entry['kind'] != 'directory':
                    raise ReleaseError('Artifact link crosses a non-directory target')
                resolved.append(part)
        return '/'.join(resolved)

    graph = {name: set() for name, entry in entries.items() if entry['kind'] == 'directory'}
    for name in graph:
        if name:
            graph[name.rpartition('/')[0]].add(name)
    records = []
    for name, entry in sorted(links.items()):
        target = resolve(name)
        if entries[target]['kind'] == 'directory':
            graph[name.rpartition('/')[0]].add(target)
        records.append({'path': name, 'kind': 'symlink', 'target': entry['target']})
    # A directory link to an ancestor or two mutually linked directories can
    # make a traversal cyclic even though resolving each individual link ends.
    visited = {}
    for name in graph:
        if visited.get(name) == 2:
            continue
        stack = [(name, False)]
        while stack:
            current, leaving = stack.pop()
            if leaving:
                visited[current] = 2
                continue
            if visited.get(current) == 1:
                raise ReleaseError('Artifact directory links form a cycle')
            if visited.get(current) == 2:
                continue
            visited[current] = 1
            stack.append((current, True))
            stack.extend((child, False) for child in sorted(graph[current], reverse=True))
    return records


def snapshot_artifact(path: Path, destination: Path, allow_internal_links: bool = False) -> str:
    """Copy each physical regular file once; optionally preserve reviewed internal links."""
    if not hasattr(os, 'O_NOFOLLOW') or not hasattr(os, 'O_DIRECTORY'):
        raise ReleaseError('This platform cannot enforce the reviewed artifact snapshot boundary')
    before = path.lstat()
    if not (stat.S_ISREG(before.st_mode) or stat.S_ISDIR(before.st_mode)):
        raise ReleaseError('Artifacts must be regular files or directories, not links or special files')
    destination.mkdir(mode=0o700)
    descriptor = None
    try:
        if stat.S_ISREG(before.st_mode):
            descriptor = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
            value = copy_regular_at(descriptor, path.name, before, destination / path.name)
            if fingerprint(path.lstat()) != fingerprint(before):
                raise ReleaseError('Selected artifact changed before its snapshot was sealed')
            return value
        descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        if fingerprint(os.fstat(descriptor)) != fingerprint(before):
            raise ReleaseError('Artifact root changed while opening it')
        entries, records = artifact_inventory(descriptor, destination)
        has_links = any(entry['kind'] == 'symlink' for entry in entries.values())
        if has_links and not allow_internal_links:
            raise ReleaseError('Artifact symlinks require --allow-internal-artifact-links')
        links = internal_artifact_links(entries) if has_links else []
        if not records:
            raise ReleaseError('Artifact contains no regular files')
        current, _ = artifact_inventory(descriptor)
        if entries != current or fingerprint(path.lstat()) != fingerprint(before):
            raise ReleaseError('Artifact changed before its snapshot was sealed')
        for link in links:
            (destination / link['path']).symlink_to(link['target'])
        return digest(json.dumps(sorted([*records, *links], key=lambda row: row['path']), sort_keys=True).encode())
    except BaseException:
        shutil.rmtree(destination)
        raise
    finally:
        if descriptor is not None:
            os.close(descriptor)


def scan_release(root: Path, artifacts: list[Path] | None = None, database: Path | None = None,
                 allow_internal_artifact_links: bool = False) -> dict:
    root = root.resolve()
    boundary = audit(root)
    if not boundary['sourceChecksPassed']:
        return {'scanComplete': False, 'sourceBoundary': {'status': 'failed', 'findingCount': len(boundary['findings'])}}
    reviews = load_reviews(root / 'tools/scan-allowlist.json')
    with tempfile.TemporaryDirectory(prefix='chimeric-release-scan-') as name:
        temporary = Path(name)
        source = temporary / 'source'
        source.mkdir()
        records = []
        for path in selected_paths(root):
            relative = path.relative_to(root)
            data = path.read_bytes()
            target = source / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
            records.append({'path': relative.as_posix(), 'sha256': digest(data)})
        if not audit(source, strict_tree=True)['sourceChecksPassed']:
            raise ReleaseError('The source snapshot failed its release boundary check')
        targets, artifact_records = [source], []
        for index, path in enumerate(artifacts or []):
            destination = temporary / ('artifact-' + str(index))
            value = snapshot_artifact(path, destination, allow_internal_artifact_links)
            targets.append(destination)
            artifact_records.append({'index': index, 'kind': 'file' if path.is_file() else 'directory', 'sha256': value,
                                     'linkPolicy': 'relative-internal-acyclic' if allow_internal_artifact_links else 'reject-all'})
        secrets = gitleaks_scan(source, temporary, reviews)
        malware = clamav_scan(targets, temporary, database)
        return {'scanComplete': secrets['status'] == 'passed' and malware['status'] == 'passed',
                'scope': 'reviewed integration source and explicitly selected local artifact snapshots',
                'sourceBoundary': {'status': 'passed', 'fileCount': len(records),
                                   'sha256': digest(json.dumps(records, sort_keys=True).encode())},
                'artifacts': artifact_records, 'gitleaks': secrets, 'clamav': malware,
                'openReleaseGates': boundary['openReleaseGates'],
                'limits': ['Known signatures and secret patterns cannot prove an artifact is malware-free.',
                           'Source secret scanning does not inspect Git history or binary artifact contents.']}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=ROOT)
    parser.add_argument('--artifact', type=Path, action='append', default=[])
    parser.add_argument('--clamav-database', type=Path)
    parser.add_argument('--allow-internal-artifact-links', action='store_true',
                        help='Preserve only relative internal artifact links after validating their complete target graph')
    arguments = parser.parse_args()
    try:
        result = scan_release(arguments.root, arguments.artifact, arguments.clamav_database,
                              arguments.allow_internal_artifact_links)
    except (OSError, ValueError, ReleaseError):
        # Inputs and scanner logs may contain sensitive data. Keep diagnostics structural.
        result = {'scanComplete': False, 'error': 'Invalid scan boundary, review configuration, or local scanner input'}
    print(json.dumps(result, indent=2))
    return 0 if result.get('scanComplete') else 1


if __name__ == '__main__':
    raise SystemExit(main())
