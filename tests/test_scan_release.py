"""Exercise local scanner boundaries and failure reporting with synthetic input."""
from datetime import datetime, timedelta, timezone
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tools'))
spec = importlib.util.spec_from_file_location('scan_release', Path(__file__).resolve().parents[1] / 'tools/scan-release.py')
scanner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(scanner)


class LocalScannerTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.base = Path(temporary.name)
        self.source = self.base / 'source'
        self.source.mkdir()
        self.line = b"const apiKey = 'synthetic-test-value-only';"
        (self.source / 'example.ts').write_bytes(self.line + b'\n')
        self.finding = {'File': 'example.ts', 'StartLine': 1, 'EndLine': 1,
                        'RuleID': 'generic-api-key', 'Secret': 'synthetic-test-value-only',
                        'Match': self.line.decode()}
        self.review = {'path': 'example.ts', 'rule': 'generic-api-key',
                       'lineSha256': hashlib.sha256(self.line).hexdigest(), 'reason': 'Synthetic fixture'}

    def test_review_requires_exact_rule_path_and_source_line(self):
        result = scanner.classify_findings([self.finding], self.source, [self.review])
        self.assertEqual(result['status'], 'passed')
        self.assertEqual(result['reviewedFindingCount'], 1)
        (self.source / 'example.ts').write_text("const apiKey = 'a-different-synthetic-value';\n")
        self.assertEqual(scanner.classify_findings([self.finding], self.source, [self.review])['status'], 'findings')
        (self.source / 'other.ts').write_bytes(self.line + b'\n')
        finding = dict(self.finding, File='other.ts')
        self.assertEqual(scanner.classify_findings([finding], self.source, [self.review])['status'], 'findings')
        finding = dict(self.finding, RuleID='another-rule')
        self.assertEqual(scanner.classify_findings([finding], self.source, [self.review])['status'], 'findings')

    def test_finding_report_discards_secret_match_and_description(self):
        result = scanner.classify_findings([self.finding], self.source, [])
        self.assertEqual(result['findings'], [{'path': 'example.ts', 'line': 1, 'rule': 'generic-api-key'}])
        self.assertNotIn(self.finding['Secret'], json.dumps(result))
        with self.assertRaises(scanner.ReleaseError):
            scanner.classify_findings([dict(self.finding, File='../outside')], self.source, [])
        with self.assertRaises(scanner.ReleaseError):
            scanner.classify_findings([dict(self.finding, StartLine=2, EndLine=2)], self.source, [])

    def test_scanner_environment_does_not_inherit_credentials_or_configuration(self):
        with patch.dict(os.environ, {'OPENAI_API_KEY': 'synthetic', 'GITLEAKS_CONFIG': '/private/config', 'HOME': '/private/home'}):
            environment = scanner.scanner_environment(self.base)
        self.assertNotIn('OPENAI_API_KEY', environment)
        self.assertNotIn('GITLEAKS_CONFIG', environment)
        self.assertEqual(environment['HOME'], str(self.base))

    def test_unavailable_scanners_do_not_pass(self):
        with patch.object(scanner.shutil, 'which', return_value=None):
            self.assertEqual(scanner.gitleaks_scan(self.source, self.base, [])['status'], 'unavailable')
            self.assertEqual(scanner.clamav_scan([self.source], self.base)['status'], 'unavailable')

    def test_gitleaks_errors_and_invalid_reports_never_echo_scanner_output(self):
        outputs = [subprocess.CompletedProcess([], 2, '', 'synthetic-sensitive-stderr'),
                   subprocess.CompletedProcess([], 0, 'synthetic-sensitive-json', ''),
                   subprocess.CompletedProcess([], 0, json.dumps([self.finding]), '')]
        for output in outputs:
            with self.subTest(exit=output.returncode), patch.object(scanner.shutil, 'which', return_value='/scanner/gitleaks'), \
                    patch.object(scanner, 'run_local', side_effect=[subprocess.CompletedProcess([], 0, '8.30.1', ''), output]):
                result = scanner.gitleaks_scan(self.source, self.base, [])
                self.assertEqual(result['status'], 'error')
                self.assertNotIn('synthetic-sensitive', json.dumps(result))
                self.assertNotIn(self.finding['Secret'], json.dumps(result))

    def test_malware_pass_requires_fresh_database_success_and_nonzero_scan_count(self):
        version = 'ClamAV 1.4.3/12345/' + datetime.now(timezone.utc).strftime('%a %b %d %H:%M:%S %Y')
        cases = [(0, 'Scanned files: 2\nInfected files: 0\n', 'passed'),
                 (0, 'Scanned files: 0\nInfected files: 0\n', 'error'),
                 (0, 'Scanned files: 2\nInfected files: 0\nTotal errors: 1\n', 'error'),
                 (1, 'synthetic-sensitive-path: Synthetic.Found FOUND\nScanned files: 2\nInfected files: 1\n', 'findings'),
                 (2, 'synthetic-sensitive-diagnostics', 'error')]
        for exit_code, output, expected in cases:
            responses = [subprocess.CompletedProcess([], 0, version, ''), subprocess.CompletedProcess([], exit_code, output, '')]
            with self.subTest(exit=exit_code, expected=expected), \
                    patch.object(scanner.shutil, 'which', return_value='/scanner/clamscan'), \
                    patch.object(scanner, 'run_local', side_effect=responses) as run:
                result = scanner.clamav_scan([self.source], self.base)
                self.assertEqual(result['status'], expected)
                self.assertNotIn('synthetic-sensitive', json.dumps(result))
                self.assertIn('--alert-exceeds-max=yes', run.call_args_list[1].args[0])

    def test_stale_or_unknown_signature_database_is_incomplete(self):
        stale = datetime.now(timezone.utc) - timedelta(days=9)
        for version in ('ClamAV 1.4.3/12345/' + stale.strftime('%a %b %d %H:%M:%S %Y'), 'ClamAV 1.4.3'):
            with patch.object(scanner.shutil, 'which', return_value='/scanner/clamscan'), \
                    patch.object(scanner, 'run_local', return_value=subprocess.CompletedProcess([], 0, version, '')) as run:
                self.assertEqual(scanner.clamav_scan([self.source], self.base)['status'], 'database-unverified-or-stale')
                self.assertEqual(run.call_count, 1)

    def test_relative_signature_database_is_resolved_before_scanner_subprocess(self):
        version = 'ClamAV 1.4.3/12345/' + datetime.now(timezone.utc).strftime('%a %b %d %H:%M:%S %Y')
        responses = [subprocess.CompletedProcess([], 0, version, ''),
                     subprocess.CompletedProcess([], 0, 'Scanned files: 1\nInfected files: 0\nTotal errors: 0\n', '')]
        relative = Path('relative-signature-database')
        with patch.object(scanner.shutil, 'which', return_value='/scanner/clamscan'), \
                patch.object(scanner, 'run_local', side_effect=responses) as run:
            result = scanner.clamav_scan([self.source], self.base, relative)
        self.assertEqual(result['status'], 'passed')
        expected = str(relative.resolve())
        for call in run.call_args_list:
            command = call.args[0]
            self.assertIn('--database', command)
            self.assertEqual(command[command.index('--database') + 1], expected)

    def test_artifact_snapshot_does_not_follow_symlinks(self):
        private = self.base / 'private-profile'
        private.write_text('synthetic private input')
        artifacts = self.base / 'app'
        artifacts.mkdir()
        (artifacts / 'outside').symlink_to(private)
        with self.assertRaises(scanner.ReleaseError):
            scanner.snapshot_artifact(artifacts, self.base / 'copy')
        (artifacts / 'outside').unlink()
        (artifacts / 'launcher').write_bytes(b'\x7fELFsynthetic')
        digest = scanner.snapshot_artifact(artifacts, self.base / 'copy')
        self.assertEqual(len(digest), 64)
        self.assertEqual((self.base / 'copy/launcher').read_bytes(), b'\x7fELFsynthetic')

    def artifact(self):
        root = self.base / 'app'
        (root / 'assets').mkdir(parents=True)
        (root / 'assets/data').write_bytes(b'synthetic artifact bytes')
        return root

    def test_internal_artifact_links_require_opt_in_and_preserve_only_link_text(self):
        root = self.artifact()
        (root / 'file-link').symlink_to('assets/data')
        (root / 'directory-link').symlink_to('assets', target_is_directory=True)
        (root / 'chain-link').symlink_to('file-link')
        with self.assertRaises(scanner.ReleaseError):
            scanner.snapshot_artifact(root, self.base / 'default-copy')
        copied = self.base / 'approved-copy'
        result = scanner.snapshot_artifact(root, copied, allow_internal_links=True)
        self.assertEqual(len(result), 64)
        self.assertEqual(os.readlink(copied / 'directory-link'), 'assets')
        self.assertEqual(os.readlink(copied / 'file-link'), 'assets/data')
        self.assertEqual(os.readlink(copied / 'chain-link'), 'file-link')
        self.assertEqual(scanner.regular_file_count(copied), 1)
        self.assertEqual((copied / 'assets/data').read_bytes(), b'synthetic artifact bytes')

    def test_link_target_text_is_part_of_the_artifact_digest(self):
        root = self.artifact()
        (root / 'assets/same-bytes').write_bytes((root / 'assets/data').read_bytes())
        link = root / 'alias'
        link.symlink_to('assets/data')
        before = scanner.snapshot_artifact(root, self.base / 'copy-before', True)
        link.unlink()
        link.symlink_to('assets/same-bytes')
        after = scanner.snapshot_artifact(root, self.base / 'copy-after', True)
        self.assertNotEqual(before, after)

    def test_absolute_external_dangling_and_lexically_escaping_links_are_rejected(self):
        root = self.artifact()
        outside = self.base / 'outside'
        outside.write_text('synthetic outside bytes')
        for index, target in enumerate((str(root / 'assets/data'), str(outside), '../outside',
                                        'missing', '../app/assets/data', 'C:\\private\\data')):
            with self.subTest(target=target):
                link = root / 'untrusted'
                link.symlink_to(target)
                with self.assertRaises(scanner.ReleaseError):
                    scanner.snapshot_artifact(root, self.base / ('rejected-' + str(index)), True)
                link.unlink()

    def test_resolved_escape_cannot_hide_behind_a_lexically_internal_directory_alias(self):
        root = self.artifact()
        (root / 'a/b').mkdir(parents=True)
        (root / 'other').mkdir()
        (root / 'a/b/alias').symlink_to('../../other', target_is_directory=True)
        (root / 'escape').symlink_to('a/b/alias/../../outside')
        with self.assertRaisesRegex(scanner.ReleaseError, 'resolves outside'):
            scanner.snapshot_artifact(root, self.base / 'copy', True)

    def test_file_and_directory_link_cycles_are_rejected(self):
        root = self.artifact()
        (root / 'one').symlink_to('two')
        (root / 'two').symlink_to('one')
        with self.assertRaises(scanner.ReleaseError):
            scanner.snapshot_artifact(root, self.base / 'file-cycle', True)
        (root / 'one').unlink()
        (root / 'two').unlink()
        (root / 'a').mkdir()
        (root / 'b').mkdir()
        (root / 'a/other').symlink_to('../b', target_is_directory=True)
        (root / 'b/other').symlink_to('../a', target_is_directory=True)
        with self.assertRaisesRegex(scanner.ReleaseError, 'cycle'):
            scanner.snapshot_artifact(root, self.base / 'directory-cycle', True)

    def test_ancestor_directory_links_are_rejected_even_if_each_link_resolves(self):
        root = self.artifact()
        (root / 'assets/parent').symlink_to('..', target_is_directory=True)
        with self.assertRaisesRegex(scanner.ReleaseError, 'cycle'):
            scanner.snapshot_artifact(root, self.base / 'copy', True)

    def test_selected_root_link_and_special_artifact_entries_are_rejected(self):
        root = self.artifact()
        alias = self.base / 'selected-link'
        alias.symlink_to(root, target_is_directory=True)
        with self.assertRaises(scanner.ReleaseError):
            scanner.snapshot_artifact(alias, self.base / 'root-copy', True)
        os.mkfifo(root / 'pipe')
        with self.assertRaises(scanner.ReleaseError):
            scanner.snapshot_artifact(root, self.base / 'pipe-copy', True)

    def test_artifact_changed_after_copy_is_refused_and_partial_snapshot_removed(self):
        root = self.artifact()
        original = scanner.copy_regular_at

        def mutate(*args):
            result = original(*args)
            (root / 'assets/data').write_bytes(b'changed synthetic bytes')
            return result

        destination = self.base / 'copy'
        with patch.object(scanner, 'copy_regular_at', side_effect=mutate):
            with self.assertRaises(scanner.ReleaseError):
                scanner.snapshot_artifact(root, destination, True)
        self.assertFalse(destination.exists())

    def test_file_replaced_by_a_link_before_open_never_copies_outside_bytes(self):
        root = self.artifact()
        outside = self.base / 'outside'
        outside.write_bytes(b'outside synthetic canary')
        original = os.open

        def replace(name, flags, *args, **kwargs):
            if name == 'data' and kwargs.get('dir_fd') is not None:
                (root / 'assets/data').unlink()
                (root / 'assets/data').symlink_to(outside)
            return original(name, flags, *args, **kwargs)

        destination = self.base / 'copy'
        with patch.object(scanner.os, 'open', side_effect=replace):
            with self.assertRaises((OSError, scanner.ReleaseError)):
                scanner.snapshot_artifact(root, destination, True)
        self.assertFalse(destination.exists())

    def test_link_retargeted_after_validation_is_refused_before_sealing(self):
        root = self.artifact()
        link = root / 'alias'
        link.symlink_to('assets/data')
        original = scanner.internal_artifact_links

        def retarget(entries):
            result = original(entries)
            link.unlink()
            link.symlink_to('../outside')
            return result

        with patch.object(scanner, 'internal_artifact_links', side_effect=retarget):
            with self.assertRaises(scanner.ReleaseError):
                scanner.snapshot_artifact(root, self.base / 'copy', True)

    def test_clamav_expected_count_excludes_links_without_weakening_follow_link_flags(self):
        root = self.artifact()
        (root / 'file-link').symlink_to('assets/data')
        (root / 'directory-link').symlink_to('assets', target_is_directory=True)
        copied = self.base / 'copy'
        scanner.snapshot_artifact(root, copied, True)
        version = 'ClamAV 1.4.3/12345/' + datetime.now(timezone.utc).strftime('%a %b %d %H:%M:%S %Y')
        responses = [subprocess.CompletedProcess([], 0, version, ''),
                     subprocess.CompletedProcess([], 0, 'Scanned files: 1\nInfected files: 0\nTotal errors: 0\n', '')]
        with patch.object(scanner.shutil, 'which', return_value='/scanner/clamscan'), \
                patch.object(scanner, 'run_local', side_effect=responses) as run:
            result = scanner.clamav_scan([copied], self.base)
        self.assertEqual(result['status'], 'passed')
        self.assertEqual(result['minimumExpectedFiles'], 1)
        self.assertIn('--follow-dir-symlinks=0', run.call_args_list[1].args[0])
        self.assertIn('--follow-file-symlinks=0', run.call_args_list[1].args[0])

    def test_empty_files_are_copied_hashed_and_reported_but_not_required_in_clamav_scan_count(self):
        root = self.artifact()
        (root / 'assets/__init__.py').write_bytes(b'')
        (root / 'empty-alias').symlink_to('assets/__init__.py')
        copied = self.base / 'copy'
        before = scanner.snapshot_artifact(root, copied, True)
        self.assertTrue((copied / 'assets/__init__.py').is_file())
        self.assertEqual((copied / 'assets/__init__.py').read_bytes(), b'')
        self.assertEqual(scanner.regular_file_counts(copied), {'regularFileCount': 2, 'emptyFileCount': 1})
        (root / 'assets/__init__.py').unlink()
        (root / 'empty-alias').unlink()
        after = scanner.snapshot_artifact(root, self.base / 'without-empty', True)
        self.assertNotEqual(before, after)
        version = 'ClamAV 1.4.3/12345/' + datetime.now(timezone.utc).strftime('%a %b %d %H:%M:%S %Y')
        for scanned, expected in ((1, 'passed'), (0, 'error')):
            responses = [subprocess.CompletedProcess([], 0, version, ''),
                         subprocess.CompletedProcess([], 0, f'Scanned files: {scanned}\nInfected files: 0\nTotal errors: 0\n', '')]
            with self.subTest(scanned=scanned), patch.object(scanner.shutil, 'which', return_value='/scanner/clamscan'), \
                    patch.object(scanner, 'run_local', side_effect=responses):
                result = scanner.clamav_scan([copied], self.base)
            self.assertEqual(result['status'], expected)
            self.assertEqual(result['minimumExpectedFiles'], 1)
            self.assertEqual(result['regularFileCount'], 2)
            self.assertEqual(result['emptyFileCount'], 1)

    def test_a_nonempty_file_missed_by_clamav_never_becomes_an_empty_file_exception(self):
        root = self.artifact()
        (root / 'assets/second').write_bytes(b'one more nonempty file')
        (root / 'assets/empty').write_bytes(b'')
        version = 'ClamAV 1.4.3/12345/' + datetime.now(timezone.utc).strftime('%a %b %d %H:%M:%S %Y')
        responses = [subprocess.CompletedProcess([], 0, version, ''),
                     subprocess.CompletedProcess([], 0, 'Scanned files: 1\nInfected files: 0\nTotal errors: 0\n', '')]
        with patch.object(scanner.shutil, 'which', return_value='/scanner/clamscan'), \
                patch.object(scanner, 'run_local', side_effect=responses):
            result = scanner.clamav_scan([root], self.base)
        self.assertEqual(result['status'], 'error')
        self.assertEqual(result['minimumExpectedFiles'], 2)
        self.assertEqual(result['regularFileCount'], 3)
        self.assertEqual(result['emptyFileCount'], 1)

    def test_empty_only_artifact_still_requires_an_explicit_valid_scanner_summary(self):
        root = self.base / 'empty-only'
        root.mkdir()
        (root / '__init__.py').write_bytes(b'')
        version = 'ClamAV 1.4.3/12345/' + datetime.now(timezone.utc).strftime('%a %b %d %H:%M:%S %Y')
        for output, expected in (('Scanned files: 0\nInfected files: 0\n', 'passed'),
                                 ('Infected files: 0\n', 'error')):
            responses = [subprocess.CompletedProcess([], 0, version, ''), subprocess.CompletedProcess([], 0, output, '')]
            with self.subTest(output=output), patch.object(scanner.shutil, 'which', return_value='/scanner/clamscan'), \
                    patch.object(scanner, 'run_local', side_effect=responses):
                result = scanner.clamav_scan([root], self.base)
            self.assertEqual(result['status'], expected)
            self.assertEqual(result['minimumExpectedFiles'], 0)
            self.assertEqual(result['regularFileCount'], 1)
            self.assertEqual(result['emptyFileCount'], 1)

    @unittest.skipUnless(shutil.which('gitleaks'), 'Gitleaks is not installed')
    def test_real_gitleaks_detects_a_changed_fixture_and_ignores_no_inline_comments(self):
        # Assemble the synthetic high-entropy fixture so this test source has no secret-shaped literal.
        value = ''.join(('39aBcF8Z', 'pD60xE7L', 'nR2qM9gH', 'vT4wJ5kS'))
        line = "const apiKey = '" + value + "'; // gitleaks:allow"
        (self.source / 'example.ts').write_text(line + '\n')
        review = dict(self.review, lineSha256=hashlib.sha256(line.encode()).hexdigest())
        result = scanner.gitleaks_scan(self.source, self.base, [review])
        self.assertEqual(result['status'], 'passed')
        self.assertGreaterEqual(result['reviewedFindingCount'], 1)
        (self.source / 'example.ts').write_text(line.replace(value, value[::-1]) + '\n')
        self.assertEqual(scanner.gitleaks_scan(self.source, self.base, [review])['status'], 'findings')


if __name__ == '__main__':
    unittest.main()
