import importlib.util
import json
from pathlib import Path
import plistlib
import shlex
import shutil
import tempfile
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('install_macos_app', ROOT / 'tools/install-macos-app.py')
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class MacOSInstallerTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)

    def fixture_app(self, name='Chimeric.app'):
        app = self.root / name
        resources = app / 'Contents/Resources'
        runtime = resources / 'runtime'
        assets = runtime / 'assets-test/web-dist'
        assets.mkdir(parents=True)
        (assets / 'index.html').write_text('<title>Chimeric</title>')
        (assets / 'favicon.svg').write_text('<svg/>')
        (resources / 'bin').mkdir()
        (resources / 'bin/chimeric').write_text('fixture')
        (resources / 'launcher.mjs').write_text('fixture')
        with (app / 'Contents/Info.plist').open('wb') as handle:
            plistlib.dump({'CFBundleIdentifier': 'org.chimeric.workbench', 'CFBundleExecutable': 'Chimeric'}, handle)
        (runtime / 'asset-manifest.json').write_text(json.dumps({'rootRelative': 'assets-test'}))
        (resources / 'chimeric-version.json').write_text(json.dumps({'version': '0.3.0-rc.2'}))
        (app.parent / 'APP-BUILD.json').write_text(json.dumps({'app': 'Chimeric.app', 'version': '0.3.0-rc.2', 'privateProfileIncluded': False}))
        return app

    def test_bundle_preflight_rejects_private_profile_and_requires_declared_assets(self):
        app = self.fixture_app()
        with patch.object(installer, 'verify_signature'):
            info = installer.inspect_bundle(app)
        self.assertEqual(info.version, '0.3.0-rc.2')
        build_path = app.parent / 'APP-BUILD.json'
        build_path.write_text(json.dumps({'app': 'Chimeric.app', 'version': '0.3.0-rc.2', 'privateProfileIncluded': True}))
        with patch.object(installer, 'verify_signature'), self.assertRaisesRegex(ValueError, 'private-profile'):
            installer.inspect_bundle(app)
        build_path.write_text(json.dumps({'app': 'Chimeric.app', 'version': '0.3.0-rc.2', 'privateProfileIncluded': False}))
        (app / 'Contents/Resources/local-profile').mkdir()
        with patch.object(installer, 'verify_signature'), self.assertRaisesRegex(ValueError, 'private workspace'):
            installer.inspect_bundle(app)
        (app / 'Contents/Resources/local-profile').rmdir()
        (app / 'Contents/Resources/runtime/assets-test/web-dist/favicon.svg').unlink()
        with patch.object(installer, 'verify_signature'), self.assertRaisesRegex(ValueError, 'web assets'):
            installer.inspect_bundle(app)

    def test_process_selection_requires_the_exact_profile_and_installed_bundle(self):
        app = self.root / 'Applications/Chimeric.app'
        profile = self.root / 'profile'
        output = '\n'.join([
            f'101 {app}/Contents/Resources/bin/chimeric {app}/Contents/Resources/launcher.mjs daemon --profile {profile} --port 18868',
            f'102 {app}/Contents/Resources/bin/chimeric {app}/Contents/Resources/launcher.mjs daemon --profile={profile} --port 18868',
            f'103 /other/Chimeric.app/Contents/Resources/bin/chimeric x --profile {profile}',
            f'104 {app}/Contents/Resources/bin/chimeric x --profile {profile}-other',
        ])
        self.assertEqual(installer.workspace_pids(output, profile, app), [101, 102])

    def test_process_selection_rejects_callers_that_only_mention_the_runtime(self):
        app = self.root / 'Applications/Chimeric.app'
        profile = self.root / 'profile with spaces'
        executable = app / 'Contents/Resources/bin/chimeric'
        profile_argument = shlex.quote(str(profile))
        output = '\n'.join([
            f'201 /bin/zsh -lc set -e ; python3 /tmp/install-macos-app.py --profile {profile_argument} ; {executable} /tmp/check.ts',
            f'202 /usr/bin/python3 /tmp/check.py --profile {profile_argument} --runtime {executable}',
            f'203 /bin/echo {executable} --profile {profile_argument}',
            f'204 {executable}-other launcher.mjs daemon --profile {profile_argument}',
        ])
        self.assertEqual(installer.workspace_pids(output, profile, app), [])

    def test_process_selection_accepts_the_runtime_in_a_destination_with_spaces(self):
        app = self.root / 'Custom Applications/Chimeric.app'
        profile = self.root / 'profile with spaces'
        executable = app / 'Contents/Resources/bin/chimeric'
        launcher = app / 'Contents/Resources/launcher.mjs'
        output = '\n'.join([
            f'301 {executable} {shlex.quote(str(launcher))} daemon --profile {shlex.quote(str(profile))} --port 18868',
            f'302 {executable} {shlex.quote(str(launcher))} daemon {shlex.quote("--profile=" + str(profile))} --port 18868',
        ])
        self.assertEqual(installer.workspace_pids(output, profile, app), [301, 302])

    def test_replace_is_transactional_and_keeps_the_previous_bundle_as_a_backup(self):
        source_path = self.fixture_app('new/Chimeric.app')
        destination = self.fixture_app('Applications/Chimeric.app')
        (destination / 'Contents/Resources/launcher.mjs').write_text('old')
        with patch.object(installer, 'verify_signature'):
            source = installer.inspect_bundle(source_path)
            backup = installer.replace_bundle(source, destination)
        self.assertIsNotNone(backup)
        self.assertEqual((destination / 'Contents/Resources/launcher.mjs').read_text(), 'fixture')
        self.assertEqual((backup / 'Contents/Resources/launcher.mjs').read_text(), 'old')

    def test_protected_profile_migration_keeps_the_original_and_previous_default(self):
        home = self.root / 'home'
        source = home / 'Documents/research-profile'
        source_db = source / 'orgs/org-a/operon-cli.db'
        source_db.parent.mkdir(parents=True)
        source_db.write_bytes(b'workspace-db')
        previous = home / 'Library/Application Support/Chimeric'
        previous.mkdir(parents=True)
        (previous / 'existing-default-marker').write_text('preserve me')
        with patch.object(installer, 'required_copy_space', return_value=1), \
             patch.object(installer, 'clone_profile', side_effect=lambda src, dst: shutil.copytree(src, dst, symlinks=True)):
            migration = installer.migrate_protected_profile(source, previous)
        self.assertTrue(migration.migrated)
        self.assertEqual(migration.profile, previous)
        self.assertEqual((previous / 'orgs/org-a/operon-cli.db').read_bytes(), b'workspace-db')
        self.assertEqual(source_db.read_bytes(), b'workspace-db')
        self.assertIsNotNone(migration.preserved_previous_default)
        self.assertEqual((migration.preserved_previous_default / 'existing-default-marker').read_text(), 'preserve me')

    def test_migration_detects_documents_without_reading_workspace_content(self):
        home = self.root / 'home'
        self.assertTrue(installer.protected_macos_profile(home / 'Documents/Workspace', home))
        self.assertTrue(installer.protected_macos_profile(home / 'Desktop/Workspace', home))
        self.assertFalse(installer.protected_macos_profile(home / 'Library/Application Support/Chimeric', home))


if __name__ == '__main__':
    unittest.main()
