"""Install a verified Chimeric.app without leaving its old workspace daemon alive."""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import plistlib
import shlex
import shutil
import signal
import subprocess
import tempfile
import time
from uuid import uuid4
from typing import NamedTuple


PRODUCT_BUNDLE_ID = 'org.chimeric.workbench'
DEFAULT_PROFILE = Path.home() / 'Library/Application Support/Chimeric'
MACOS_PROTECTED_PROFILE_NAMES = ('Desktop', 'Documents', 'Downloads')


class BundleInfo(NamedTuple):
    app: Path
    runtime: Path
    resources: Path
    version: str


class ProfileMigration(NamedTuple):
    profile: Path
    migrated: bool
    preserved_previous_default: Path | None


def is_relative_to(path: Path, parent: Path) -> bool:
    """Return whether a normalized path is inside a normalized parent path."""
    try:
        path.resolve().relative_to(parent.resolve())
        return True
    except ValueError:
        return False


def protected_macos_profile(profile: Path, home: Path | None = None) -> bool:
    """Documents-style locations need a per-app macOS privacy grant.

    A native app may block inside open(2) while macOS asks for that grant. The
    runtime database cannot make useful progress in that state, so the
    installer moves the private runtime state to the normal application-data
    location before the native app is launched.
    """
    home = (home or Path.home()).resolve()
    candidate = profile.expanduser().resolve()
    return any(is_relative_to(candidate, home / name) for name in MACOS_PROTECTED_PROFILE_NAMES)


def profile_inventory(profile: Path) -> tuple[tuple[str, int], ...]:
    """Small, content-free integrity check for a copied Chimeric profile."""
    orgs = profile / 'orgs'
    if not orgs.is_dir():
        return ()
    rows: list[tuple[str, int]] = []
    for database in sorted(orgs.glob('*/operon-cli.db')):
        if database.is_file():
            rows.append((database.parent.name, database.stat().st_size))
    return tuple(rows)


def required_copy_space(profile: Path) -> int:
    """Return a conservative logical-size estimate before cp's clone fallback."""
    result = subprocess.run(['/usr/bin/du', '-sk', str(profile)], check=True, text=True,
                            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    fields = result.stdout.split()
    if not fields or not fields[0].isdigit():
        raise RuntimeError('Could not measure the existing Chimeric workspace.')
    # cp -c uses APFS clones when possible. Reserve a little more than a full
    # byte copy in case this profile has to fall back to a normal copy.
    return int(fields[0]) * 1024 * 11 // 10


def clone_profile(source: Path, staged: Path) -> None:
    """Clone when APFS allows it, with cp's safe regular-copy fallback."""
    subprocess.run(['/bin/cp', '-cR', '-p', str(source), str(staged)], check=True,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def migrate_protected_profile(profile: Path, destination: Path = DEFAULT_PROFILE) -> ProfileMigration:
    """Relocate a protected profile without deleting either existing copy.

    The source remains untouched. If a small pre-existing default profile
    exists, it is atomically retained beside the new one. A failure before the
    final rename leaves the original profile as the selected source.
    """
    source = profile.expanduser().resolve(strict=True)
    destination = destination.expanduser().absolute()
    resolved_destination = destination.resolve() if destination.exists() else destination
    if source == resolved_destination:
        return ProfileMigration(profile=source, migrated=False, preserved_previous_default=None)
    if not source.is_dir() or source.is_symlink():
        raise RuntimeError('The existing Chimeric workspace is not a normal directory.')
    destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    if destination.exists() and destination.is_symlink():
        raise RuntimeError('The default Chimeric workspace path is a symlink. Refusing to replace it.')
    required = required_copy_space(source)
    available = shutil.disk_usage(destination.parent).free
    if available < required:
        raise RuntimeError('There is not enough free space to relocate the Chimeric workspace safely.')
    staged = destination.with_name(f'.{destination.name}.migrating-{uuid4().hex[:12]}')
    clone_profile(source, staged)
    if not staged.is_dir() or profile_inventory(staged) != profile_inventory(source):
        raise RuntimeError('The relocated Chimeric workspace did not pass its database inventory check.')
    previous: Path | None = None
    moved_previous = False
    try:
        if destination.exists():
            previous = backup_name(destination)
            os.replace(destination, previous)
            moved_previous = True
        os.replace(staged, destination)
    except Exception:
        if moved_previous and previous and previous.exists() and not destination.exists():
            os.replace(previous, destination)
        raise
    return ProfileMigration(profile=destination, migrated=True, preserved_previous_default=previous)


def set_default_workspace(profile: Path) -> None:
    """Point the native shell at the profile that the installer verified."""
    subprocess.run(['/usr/bin/defaults', 'write', PRODUCT_BUNDLE_ID, 'workspaceProfile', '-string', str(profile)],
                   check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def safe_relative_child(parent: Path, relative: str) -> Path:
    candidate = parent / relative
    root = parent.resolve()
    resolved = candidate.resolve()
    if not relative or Path(relative).is_absolute() or (resolved != root and root not in resolved.parents):
        raise ValueError('The app declares an unsafe runtime asset path.')
    return candidate


def verify_signature(app: Path) -> None:
    subprocess.run(['/usr/bin/codesign', '--verify', '--deep', '--strict', str(app)],
                   check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def inspect_bundle(app: Path) -> BundleInfo:
    app = app.resolve(strict=True)
    contents = app / 'Contents'
    resources = contents / 'Resources'
    info_path = contents / 'Info.plist'
    version_path = resources / 'chimeric-version.json'
    manifest_path = resources / 'runtime/asset-manifest.json'
    if app.suffix != '.app' or not app.is_dir() or not info_path.is_file() or not version_path.is_file() or not manifest_path.is_file():
        raise ValueError('The source is not a complete Chimeric.app bundle.')
    with info_path.open('rb') as handle:
        info = plistlib.load(handle)
    if info.get('CFBundleIdentifier') != PRODUCT_BUNDLE_ID or info.get('CFBundleExecutable') != 'Chimeric':
        raise ValueError('The source app is not the Chimeric bundle.')
    version = str(json.loads(version_path.read_text()).get('version', ''))
    if not version:
        raise ValueError('The source app has no release version.')
    private_paths = ('local-auth', 'local-profile', 'profiles', 'provider-config.json', 'model-selection.json', 'chatgpt-models.json')
    if any((resources / name).exists() or (resources / 'runtime' / name).exists() for name in private_paths):
        raise ValueError('The source app contains private workspace data.')
    sidecar = app.parent / 'APP-BUILD.json'
    if sidecar.is_file() and json.loads(sidecar.read_text()).get('privateProfileIncluded') is not False:
        raise ValueError('The source app did not pass the private-profile packaging check.')
    manifest = json.loads(manifest_path.read_text())
    asset_root = safe_relative_child(resources / 'runtime', str(manifest.get('rootRelative', '')))
    if not (asset_root / 'web-dist/index.html').is_file() or not (asset_root / 'web-dist/favicon.svg').is_file():
        raise ValueError('The source app is missing its declared web assets.')
    if not (resources / 'bin/chimeric').is_file() or not (resources / 'launcher.mjs').is_file():
        raise ValueError('The source app is missing its local launcher.')
    verify_signature(app)
    return BundleInfo(app=app, runtime=resources / 'runtime', resources=resources, version=version)


def command_targets_profile(command: str, profile: Path) -> bool:
    try:
        tokens = shlex.split(command)
    except ValueError:
        return False
    profile_text = str(profile)
    for index, token in enumerate(tokens):
        if token == '--profile' and index + 1 < len(tokens) and tokens[index + 1] == profile_text:
            return True
        if token == f'--profile={profile_text}':
            return True
    return False


def workspace_pids(ps_output: str, profile: Path, installed_app: Path) -> list[int]:
    marker = str(installed_app / 'Contents/Resources')
    result: list[int] = []
    for raw in ps_output.splitlines():
        fields = raw.strip().split(maxsplit=1)
        if len(fields) != 2 or not fields[0].isdigit():
            continue
        pid, command = int(fields[0]), fields[1]
        if pid != os.getpid() and marker in command and command_targets_profile(command, profile):
            result.append(pid)
    return sorted(set(result))


def running_workspace_pids(profile: Path, installed_app: Path) -> list[int]:
    result = subprocess.run(['/bin/ps', '-axo', 'pid=,command='], check=True, text=True,
                            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    return workspace_pids(result.stdout, profile, installed_app)


def request_workspace_stop(profile: Path, installed_app: Path) -> None:
    resources = installed_app / 'Contents/Resources'
    binary, launcher = resources / 'bin/chimeric', resources / 'launcher.mjs'
    if not binary.is_file() or not launcher.is_file():
        return
    environment = dict(os.environ)
    environment['BUN_BE_BUN'] = '1'
    try:
        subprocess.run([str(binary), str(launcher), 'stop', '--profile', str(profile)], env=environment,
                       timeout=20, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
    except (OSError, subprocess.TimeoutExpired):
        pass


def quit_native_window() -> None:
    """Ask only the Chimeric UI to quit normally before replacing its bundle."""
    try:
        subprocess.run(['/usr/bin/osascript', '-e', f'tell application id "{PRODUCT_BUNDLE_ID}" to quit'],
                       timeout=10, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
    except (OSError, subprocess.TimeoutExpired):
        pass


def stop_workspace_for_update(profile: Path, installed_app: Path, timeout_seconds: float = 45) -> None:
    quit_native_window()
    request_workspace_stop(profile, installed_app)
    deadline = time.monotonic() + timeout_seconds
    sent_term = False
    while True:
        pids = running_workspace_pids(profile, installed_app)
        if not pids:
            return
        if not sent_term and time.monotonic() >= deadline - min(20, timeout_seconds / 2):
            for pid in pids:
                try:
                    os.kill(pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
                except PermissionError as error:
                    raise RuntimeError(f'Cannot stop Chimeric workspace process {pid}.') from error
            sent_term = True
        if time.monotonic() >= deadline:
            raise RuntimeError('The existing Chimeric workspace did not stop. The app was not replaced.')
        time.sleep(0.5)


def backup_name(destination: Path) -> Path:
    timestamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    return destination.with_name(f'{destination.stem}-backup-{timestamp}-{uuid4().hex[:8]}{destination.suffix}')


def replace_bundle(source: BundleInfo, destination: Path) -> Path | None:
    destination = destination.absolute()
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=f'.{destination.name}.install-', dir=destination.parent) as temporary:
        staged = Path(temporary) / destination.name
        shutil.copytree(source.app, staged, symlinks=True, copy_function=shutil.copy2)
        staged_info = inspect_bundle(staged)
        if staged_info.version != source.version:
            raise RuntimeError('The copied app failed its version check.')
        backup: Path | None = None
        moved_old = False
        try:
            if destination.exists() or destination.is_symlink():
                backup = backup_name(destination)
                os.replace(destination, backup)
                moved_old = True
            os.replace(staged, destination)
            return backup
        except Exception:
            if moved_old and backup and backup.exists() and not destination.exists():
                os.replace(backup, destination)
            raise


def install(source_app: Path, destination: Path, profile: Path, launch: bool, dry_run: bool,
            migrate_protected: bool = True) -> dict:
    source = inspect_bundle(source_app)
    destination = destination.absolute()
    profile = profile.expanduser().absolute()
    if dry_run:
        return {'installed': False, 'dryRun': True, 'source': str(source.app), 'destination': str(destination),
                'profile': str(profile), 'version': source.version,
                'profileMigrationNeeded': bool(migrate_protected and protected_macos_profile(profile))}
    if destination.exists() or destination.is_symlink():
        stop_workspace_for_update(profile, destination)
    migration = ProfileMigration(profile=profile, migrated=False, preserved_previous_default=None)
    if migrate_protected and protected_macos_profile(profile):
        migration = migrate_protected_profile(profile)
        set_default_workspace(migration.profile)
    backup = replace_bundle(source, destination)
    if launch:
        subprocess.run(['/usr/bin/open', '-a', str(destination)], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return {'installed': True, 'source': str(source.app), 'destination': str(destination), 'profile': str(migration.profile),
            'version': source.version, 'backup': str(backup) if backup else None, 'launched': launch,
            'profileMigrated': migration.migrated,
            'previousDefaultProfile': str(migration.preserved_previous_default) if migration.preserved_previous_default else None}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--app', type=Path, required=True, help='New verified Chimeric.app bundle')
    parser.add_argument('--destination', type=Path, default=Path('/Applications/Chimeric.app'))
    parser.add_argument('--profile', type=Path, default=DEFAULT_PROFILE)
    parser.add_argument('--launch', action='store_true', help='Open the new app after the atomic replacement')
    parser.add_argument('--dry-run', action='store_true', help='Verify the source bundle only')
    parser.add_argument('--no-migrate-protected-profile', action='store_true',
                        help='Keep a workspace under Desktop, Documents or Downloads instead of relocating it')
    args = parser.parse_args()
    try:
        print(json.dumps(install(args.app, args.destination, args.profile, args.launch, args.dry_run,
                                 migrate_protected=not args.no_migrate_protected_profile), indent=2))
    except (OSError, ValueError, RuntimeError, subprocess.CalledProcessError) as error:
        parser.error(str(error))


if __name__ == '__main__':
    main()
