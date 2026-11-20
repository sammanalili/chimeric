"""Exercise the publication boundary with private-file and failure controls."""
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tools'))
from release_check import (REQUIRED_DIRECTORIES, REQUIRED_ROOT_FILES, REQUIRED_TOOLS,
                           ReleaseError, audit, private_markers, selected_paths)

spec = importlib.util.spec_from_file_location('prepare_release', Path(__file__).resolve().parents[1] / 'tools/prepare-release.py')
exporter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(exporter)


class SourceBoundaryTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name)
        self.root = self.base / 'project'
        self.root.mkdir()
        for name in REQUIRED_DIRECTORIES:
            (self.root / name).mkdir(parents=True)
            (self.root / name / 'fixture.txt').write_text('fixture\n')
        for name in ('scientific-illustration', 'scientific-documents',
                     'scientific-writing', 'scientific-data-visualization'):
            skill = self.root / 'resources/skills' / name
            (skill / 'references').mkdir(parents=True)
            (skill / 'SKILL.md').write_text('# Synthetic science skill\n')
            (skill / 'references/style-guide.md').write_text('Synthetic style guide\n')
        (self.root / 'tools').mkdir()
        for name in REQUIRED_TOOLS:
            path = self.root / 'tools' / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text('# fixture\n')
        (self.root / 'src/example.ts').write_text('export const answer=42;\n')
        policy = {'files': sorted(REQUIRED_ROOT_FILES),
                  'directories': sorted(REQUIRED_DIRECTORIES),
                  'tools': sorted(REQUIRED_TOOLS)}
        (self.root / 'release.manifest.json').write_text(json.dumps(policy))
        (self.root / 'README.md').write_text('# Example\n\n[Source](src/example.ts)\n')
        (self.root / 'release-status.json').write_text(json.dumps({'version': '0.2.0-rc.1', 'channel': 'development', 'releaseGates': [{'id': 'runtime', 'status': 'pending'}]}))
        (self.root / 'package.json').write_text(json.dumps({'version': '0.2.0-rc.1'}))
        for name in REQUIRED_ROOT_FILES - {'README.md', 'release.manifest.json', 'release-status.json', 'package.json'}:
            (self.root / name).write_text('# fixture\n')

    def rewrite_policy(self, policy):
        (self.root / 'release.manifest.json').write_text(json.dumps(policy))

    def test_export_excludes_unselected_profile_and_preserves_bytes(self):
        private = self.root / 'local-auth'
        private.mkdir()
        (private / 'providers.key').write_text('private fixture key')
        output = self.base / 'export'
        result = exporter.export_source(self.root, output)
        self.assertTrue(result['sourceChecksPassed'])
        self.assertFalse((output / 'local-auth').exists())
        self.assertEqual((output / 'src/example.ts').read_bytes(), (self.root / 'src/example.ts').read_bytes())
        self.assertEqual(result['openReleaseGates'], ['runtime'])
        self.assertFalse(json.loads((output / 'SOURCE-MANIFEST.json').read_text())['originalRuntimeIncluded'])
        self.assertEqual(json.loads((output / 'SOURCE-MANIFEST.json').read_text())['version'], '0.2.0-rc.1')
        self.assertEqual(result['version'], '0.2.0-rc.1')
        for name in ('native-memory.ts', 'tailnet-proxy.mjs', 'docker-seccomp.json',
                     'antigravity-http-bridge/main.go', 'antigravity-http-bridge/main_test.go', 'antigravity-http-bridge/go.mod'):
            self.assertTrue((output / 'tools' / name).is_file(), name)
        self.assertTrue((output / 'Dockerfile').is_file())

    def test_concurrent_staged_change_does_not_publish_an_unchecked_tree(self):
        original_audit = exporter.audit
        def change_after_check(root, markers=None, strict_tree=False):
            result = original_audit(root, markers, strict_tree)
            if root.resolve() != self.root.resolve():
                (root / 'src/example.ts').write_text('changed after the staged audit')
            return result
        with patch.object(exporter, 'audit', side_effect=change_after_check):
            with self.assertRaisesRegex(ReleaseError, 'Staged files changed'):
                exporter.export_source(self.root, self.base / 'export')
        self.assertFalse((self.base / 'export').exists())

    def test_export_contains_four_science_skills_and_builder_without_runtime(self):
        for name in ('local-profile', 'runtime', 'resources/recovered-runtime'):
            private = self.root / name
            private.mkdir(parents=True)
            (private / 'private-fixture.txt').write_text('not part of the source export')
        output = self.base / 'export'
        exporter.export_source(self.root, output)
        for name in ('scientific-illustration', 'scientific-documents',
                     'scientific-writing', 'scientific-data-visualization'):
            for filename in ('SKILL.md', 'references/style-guide.md'):
                relative = Path('resources/skills') / name / filename
                self.assertEqual((output / relative).read_bytes(), (self.root / relative).read_bytes())
        for name in ('bundled_science_skills.py', 'scan-release.py', 'scan-allowlist.json'):
            self.assertTrue((output / 'tools' / name).is_file())
        self.assertFalse((output / 'local-profile').exists())
        self.assertFalse((output / 'runtime').exists())
        self.assertFalse((output / 'resources/recovered-runtime').exists())
        self.assertTrue(audit(output, strict_tree=True)['sourceChecksPassed'])

    def test_manifest_metadata_describes_exported_bytes(self):
        original_audit = exporter.audit
        def update_before_copy(root, markers=None, strict_tree=False):
            result = original_audit(root, markers, strict_tree)
            if root.resolve() == self.root.resolve():
                status_path = root / 'release-status.json'
                status = json.loads(status_path.read_text())
                status['version'] = '0.2.0-rc.2'
                status['channel'] = 'prerelease'
                status_path.write_text(json.dumps(status))
                (root / 'package.json').write_text(json.dumps({'version': status['version']}))
            return result
        with patch.object(exporter, 'audit', side_effect=update_before_copy):
            result = exporter.export_source(self.root, self.base / 'export')
        manifest = json.loads((self.base / 'export/SOURCE-MANIFEST.json').read_text())
        self.assertEqual(manifest['version'], '0.2.0-rc.2')
        self.assertEqual(manifest['channel'], 'prerelease')
        self.assertEqual(result['version'], manifest['version'])

    def test_private_file_inside_selected_tree_blocks_export(self):
        (self.root / 'src/providers.key').write_text('private fixture key')
        with self.assertRaises(ReleaseError):
            exporter.export_source(self.root, self.base / 'export')
        self.assertFalse((self.base / 'export').exists())

    def test_missing_science_skill_blocks_an_incomplete_export(self):
        (self.root / 'resources/skills/scientific-writing/SKILL.md').unlink()
        with self.assertRaisesRegex(ReleaseError, 'Missing required source file'):
            exporter.export_source(self.root, self.base / 'export')
        self.assertFalse((self.base / 'export').exists())

    def test_symlink_to_private_file_is_rejected(self):
        (self.base / 'private.txt').write_text('fixture secret')
        (self.root / 'src/alias.ts').symlink_to(self.base / 'private.txt')
        with self.assertRaises(ReleaseError):
            selected_paths(self.root)

    def test_symlinked_tools_ancestor_is_rejected(self):
        original = self.root / 'tools/antigravity-http-bridge'
        target = self.root / 'transport'
        original.rename(target)
        original.symlink_to(target, target_is_directory=True)
        with self.assertRaisesRegex(ReleaseError, 'Unsafe source path'):
            selected_paths(self.root)

    def test_manifest_cannot_escape_the_project(self):
        (self.base / 'private.txt').write_text('fixture secret')
        policy = json.loads((self.root / 'release.manifest.json').read_text())
        policy['files'].append('../private.txt')
        self.rewrite_policy(policy)
        with self.assertRaises(ReleaseError):
            selected_paths(self.root)

    def test_manifest_cannot_drop_reviewed_source_area(self):
        policy = json.loads((self.root / 'release.manifest.json').read_text())
        for directory in ('src', 'tests', 'docs', '.github', 'resources/skills'):
            candidate = json.loads(json.dumps(policy))
            candidate['directories'].remove(directory)
            self.rewrite_policy(candidate)
            with self.subTest(directory=directory), self.assertRaisesRegex(ReleaseError, 'complete reviewed source boundary'):
                selected_paths(self.root)
        candidate = json.loads(json.dumps(policy))
        candidate['tools'].remove('release_check.py')
        self.rewrite_policy(candidate)
        with self.assertRaisesRegex(ReleaseError, 'complete reviewed source boundary'):
            selected_paths(self.root)
        for tool in ('bundled_science_skills.py', 'scan-release.py', 'scan-allowlist.json'):
            candidate = json.loads(json.dumps(policy))
            candidate['tools'].remove(tool)
            self.rewrite_policy(candidate)
            with self.subTest(tool=tool), self.assertRaisesRegex(ReleaseError, 'complete reviewed source boundary'):
                selected_paths(self.root)

    def test_stale_output_is_never_overwritten(self):
        output = self.base / 'export'
        output.mkdir()
        (output / 'keep.txt').write_text('keep')
        with self.assertRaises(ReleaseError):
            exporter.export_source(self.root, output)
        self.assertEqual((output / 'keep.txt').read_text(), 'keep')

    def test_broken_and_outside_links_fail(self):
        (self.root / 'README.md').write_text('[Missing](missing.md)\n[Outside](../private.txt)\n')
        result = audit(self.root)
        self.assertFalse(result['sourceChecksPassed'])
        self.assertEqual(len(result['findings']), 2)

    def test_known_secret_pattern_is_redacted_in_report(self):
        credential = 'sk-' + 'A' * 40
        (self.root / 'src/example.ts').write_text('const key=' + repr(credential))
        result = audit(self.root)
        self.assertFalse(result['sourceChecksPassed'])
        self.assertNotIn(credential, json.dumps(result))

    def test_additional_service_credentials_are_blocked_without_echoing_values(self):
        credentials = [prefix + 'A' * count for prefix, count in (
            ('AIza', 35), ('ya29.', 40), ('1//', 40), ('AKIA', 16), ('xoxb-', 35),
            ('code=oaistb_ac_', 40))]
        credentials.append('eyJ' + 'A' * 20 + '.' + 'B' * 20 + '.' + 'C' * 20)
        credentials.append('GOC' + 'SPX-' + 'A' * 24)
        credentials.append('1234567890-' + 'a' * 32 + '.apps.' + 'googleusercontent.com')
        for credential in credentials:
            with self.subTest(kind=credential[:4]):
                (self.root / 'src/example.ts').write_text('const value=' + repr(credential))
                result = audit(self.root)
                self.assertFalse(result['sourceChecksPassed'])
                self.assertNotIn(credential, json.dumps(result))

    def test_private_credential_and_capture_files_are_blocked(self):
        for name in ('token.json', 'credentials.json', 'auth.json', 'capture.jsonl', 'identity.p12'):
            with self.subTest(name=name):
                path = self.root / 'src' / name
                path.write_text('synthetic private fixture')
                self.assertFalse(audit(self.root)['sourceChecksPassed'])
                path.unlink()

    def test_release_metadata_versions_must_match(self):
        (self.root / 'package.json').write_text(json.dumps({'version': '0.2.0-rc.2'}))
        result = audit(self.root)
        self.assertIn('release-status.json: version must match package.json', result['findings'])
        (self.root / 'package.json').write_text(json.dumps({'version': 'next'}))
        self.assertIn('package.json: a semantic release version is required', audit(self.root)['findings'])

    def test_private_markers_must_be_nonempty_strings(self):
        path = self.base / 'markers.json'
        for value in ({'secret': 'fixture'}, [''], [42]):
            path.write_text(json.dumps(value))
            with self.subTest(type=type(value).__name__), self.assertRaises(ReleaseError):
                private_markers(path)
        path.write_text(json.dumps(['private-fixture']))
        self.assertEqual(private_markers(path), [b'private-fixture'])

    def test_private_marker_and_unselected_file_controls(self):
        (self.root / 'src/example.ts').write_text('private-deployment-marker')
        result = audit(self.root, [b'private-deployment-marker'])
        self.assertFalse(result['sourceChecksPassed'])
        (self.root / 'unexpected.txt').write_text('not selected')
        self.assertTrue(any('unselected' in finding for finding in audit(self.root, strict_tree=True)['findings']))


if __name__ == '__main__':
    unittest.main()
