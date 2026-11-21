import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import tarfile
import io
import gzip
import unittest
from unittest.mock import patch

ROOT = Path(__file__).parents[1]
spec = importlib.util.spec_from_file_location("build_portable", ROOT / "tools/build-portable.py")
build_portable = importlib.util.module_from_spec(spec)
spec.loader.exec_module(build_portable)
mac_spec = importlib.util.spec_from_file_location("build_macos_app", ROOT / "tools/build-macos-app.py")
build_macos_app = importlib.util.module_from_spec(mac_spec)
mac_spec.loader.exec_module(build_macos_app)
GO = shutil.which("go") or ("/opt/homebrew/bin/go" if Path("/opt/homebrew/bin/go").is_file() else None)

class PortableExportTests(unittest.TestCase):
    def test_icns_writer_records_every_generated_png_at_its_exact_size(self):
        root = Path(self.tmp.name)
        iconset = root / 'Synthetic.iconset'
        iconset.mkdir()
        for name, _kind, size in build_macos_app.ICNS_IMAGES:
            header = b'\x89PNG\r\n\x1a\n' + (13).to_bytes(4, 'big') + b'IHDR'
            (iconset / name).write_bytes(header + size.to_bytes(4, 'big') * 2 + b'fixture')
        output = root / 'Synthetic.icns'
        build_macos_app.write_icns(iconset, output)
        data = output.read_bytes()
        self.assertEqual(data[:4], b'icns')
        self.assertEqual(int.from_bytes(data[4:8], 'big'), len(data))
        for _name, kind, _size in build_macos_app.ICNS_IMAGES:
            self.assertEqual(data.count(kind), 1)
        bad = bytearray((iconset / 'icon_16x16.png').read_bytes())
        bad[20:24] = (17).to_bytes(4, 'big')
        (iconset / 'icon_16x16.png').write_bytes(bad)
        with self.assertRaisesRegex(ValueError, 'icon_16x16.png'):
            build_macos_app.write_icns(iconset, root / 'bad.icns')

    def test_release_versions_match_package_metadata(self):
        version = json.loads((ROOT / 'package.json').read_text())['version']
        self.assertEqual(build_portable.release_metadata()['version'], version)
        self.assertEqual(build_portable.macos_versions('0.2.0-rc.1'), ('0.2.0', '0.2.0fc1'))
        self.assertEqual(build_portable.macos_versions('0.2.0'), ('0.2.0', '0.2.0'))
        with self.assertRaises(ValueError): build_portable.macos_versions('0.2.0-rc.256')

    def test_macos_class2_receipt_binds_final_resources_and_linux_cannot_mint_one(self):
        root = Path(self.tmp.name) / 'receipt-fixture'; resources = root / 'Chimeric.app/Contents/Resources'; runtime = resources / 'runtime'
        shutil.copytree(self.runtime, runtime); (resources / 'bin').mkdir(parents=True); shutil.copy2(self.binary, resources / 'bin/chimeric')
        patches = json.loads((runtime / 'patch-manifest.json').read_text())
        patches.update({'platform': 'darwin-arm64', 'boundaries': list(build_portable.CLASS2_REQUIRED_BOUNDARIES),
                        'class2RequiredBoundaries': list(build_portable.CLASS2_REQUIRED_BOUNDARIES)})
        (runtime / 'patch-manifest.json').write_text(json.dumps(patches))
        receipt_record = build_portable._write_class2_receipt(resources, platform='darwin-arm64', epoch_ms=1700000000123)
        receipt_path = runtime / 'class2-build-receipt.json'; receipt = json.loads(receipt_path.read_text())
        self.assertEqual(receipt_record['attestationEpoch'], 1700000000123); self.assertTrue(receipt_record['protectedExecution'])
        self.assertEqual(receipt_record['sha256'], hashlib.sha256(receipt_path.read_bytes()).hexdigest())
        self.assertEqual(receipt['files']['runtime/local-runtime.js'], hashlib.sha256((runtime / 'local-runtime.js').read_bytes()).hexdigest())
        self.assertEqual(receipt['files']['bin/chimeric'], hashlib.sha256((resources / 'bin/chimeric').read_bytes()).hexdigest())
        self.assertEqual(receipt['requiredBoundaries'], list(build_portable.CLASS2_REQUIRED_BOUNDARIES))
        with self.assertRaisesRegex(ValueError, 'only for the verified macOS target'):
            build_portable._write_class2_receipt(resources, platform='linux-x64')
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name); self.runtime = root / "runtime"; self.runtime.mkdir()
        self.binary = root / "native"; self.binary.write_bytes(b"small-test-native"); self.binary.chmod(0o755)
        self.assets = self.runtime / "assets-science-test"; self.assets.mkdir()
        (self.assets / ".science-assets-sha256").write_text("asset-test-sha\n"); (self.assets / "payload.txt").write_text("safe\n")
        tar_bytes = io.BytesIO()
        with tarfile.open(fileobj=tar_bytes, mode="w") as tar:
            info = tarfile.TarInfo("."); info.type = tarfile.DIRTYPE; tar.addfile(info)
            tar.add(self.assets / "payload.txt", arcname="./payload.txt")
        raw_tar = tar_bytes.getvalue(); asset_sha = hashlib.sha256(raw_tar).hexdigest()
        (self.assets / ".science-assets-sha256").write_text(asset_sha + "\n")
        (self.runtime / "assets.tar-test.gz").write_bytes(gzip.compress(raw_tar))
        for name in build_portable.REQUIRED_RUNTIME:
            path = self.runtime / name; path.parent.mkdir(parents=True, exist_ok=True)
            if name == "asset-manifest.json": path.write_text(json.dumps({"archive": "assets.tar-test.gz", "rootRelative": self.assets.name, "sha256": asset_sha, "moduleVersion": "?test"}))
            elif name == "patch-manifest.json": path.write_text(json.dumps({"platform": "linux-x64", "sourceSha256": "source-test"}))
            else: path.write_text("runtime\n")
        patches = {"platform": "linux-x64", "sourceSha256": build_portable.EXPECTED_SOURCE_SHA256, "outputSha256": hashlib.sha256((self.runtime / "chimeric.js").read_bytes()).hexdigest()}
        (self.runtime / "patch-manifest.json").write_text(json.dumps(patches))
        self.expected = hashlib.sha256(self.binary.read_bytes()).hexdigest()

    def tearDown(self): self.tmp.cleanup()

    @unittest.skipUnless(GO, "Go is required to compile the packaged transport")
    def test_export_is_integrity_recorded_and_fresh(self):
        out = Path(self.tmp.name) / "export"
        with patch.dict(os.environ, {"CHIMERIC_GO": GO}):
            record = build_portable.export_bundle(self.runtime, self.binary, out, expected_binary_sha256=self.expected)
        self.assertFalse(record["executionVerified"]); self.assertEqual(record["assetTreeTarSha256"], json.loads((self.runtime / "asset-manifest.json").read_text())["sha256"])
        self.assertEqual(record['class2Protection']['supported'], False); self.assertFalse((out / 'runtime/class2-build-receipt.json').exists())
        self.assertEqual(record['version'], json.loads((ROOT / 'package.json').read_text())['version'])
        self.assertEqual(json.loads((out / 'chimeric-version.json').read_text()), build_portable.release_metadata())
        helper = out / "bin/agy-http-bridge"
        self.assertEqual(helper.read_bytes()[:6], b"\x7fELF\x02\x01")
        self.assertTrue(os.access(helper, os.X_OK))
        self.assertEqual(record["antigravityTransport"]["binarySha256"], hashlib.sha256(helper.read_bytes()).hexdigest())
        self.assertEqual(record["antigravityTransport"]["sourceSha256"], hashlib.sha256((ROOT / "tools/antigravity-http-bridge/main.go").read_bytes()).hexdigest())
        self.assertEqual((out / "runtime/assets-science-test/payload.txt").read_text(), "safe\n")
        for name in build_portable.BROWSER_MODULES:
            self.assertEqual((out / "runtime" / name).read_bytes(), (self.runtime / name).read_bytes())
            self.assertFalse((out / "runtime" / name).with_suffix('.ts').exists())
        for name in ['antigravity-client.js', 'antigravity.css']:
            self.assertFalse((out / "runtime" / name).exists())
        with self.assertRaisesRegex(ValueError, "must not already exist"): build_portable.export_bundle(self.runtime, self.binary, out, expected_binary_sha256=self.expected)

    def test_missing_transport_compiler_rejects_export(self):
        out = Path(self.tmp.name) / "missing-compiler"
        with patch.dict(os.environ, {"CHIMERIC_GO": str(Path(self.tmp.name) / "absent-go")}):
            with self.assertRaisesRegex(ValueError, "Go compiler is required"):
                build_portable.export_bundle(self.runtime, self.binary, out, expected_binary_sha256=self.expected)
        self.assertFalse(out.exists())

    def test_failed_transport_compile_leaves_no_package(self):
        out = Path(self.tmp.name) / "failed-compiler"
        with patch.dict(os.environ, {"CHIMERIC_GO": "/usr/bin/false"}):
            with self.assertRaisesRegex(ValueError, "Could not build"):
                build_portable.export_bundle(self.runtime, self.binary, out, expected_binary_sha256=self.expected)
        self.assertFalse(out.exists())

    @unittest.skipUnless(GO and os.uname().sysname == "Darwin" and os.uname().machine == "arm64", "native Apple Silicon compile check")
    def test_macos_transport_executes_without_network(self):
        helper = Path(self.tmp.name) / "macos/bin/agy-http-bridge"
        with patch.dict(os.environ, {"CHIMERIC_GO": GO}):
            record = build_portable.build_antigravity_bridge(helper, platform="darwin-arm64")
        result = subprocess.run([str(helper), "--version"], check=True, capture_output=True, text=True, timeout=5)
        self.assertEqual(result.stdout.strip(), "agy-http-bridge 1")
        self.assertEqual(record["platform"], "darwin-arm64")
        self.assertEqual(record["binarySha256"], hashlib.sha256(helper.read_bytes()).hexdigest())

    def test_missing_image_settings_rejects_export(self):
        (self.runtime / 'image-generation-settings.js').unlink()
        with self.assertRaisesRegex(ValueError, 'image-generation-settings.js'):
            build_portable.export_bundle(self.runtime, self.binary, Path(self.tmp.name) / 'missing-images', expected_binary_sha256=self.expected)

    def test_rejects_bad_archive_hash(self):
        manifest = json.loads((self.runtime / "asset-manifest.json").read_text()); manifest["archiveSha256"] = "0" * 64
        (self.runtime / "asset-manifest.json").write_text(json.dumps(manifest))
        with self.assertRaisesRegex(ValueError, "archiveSha256"): build_portable.export_bundle(self.runtime, self.binary, Path(self.tmp.name) / "bad", expected_binary_sha256=self.expected)

    def test_rejects_asset_path_escape(self):
        manifest = json.loads((self.runtime / "asset-manifest.json").read_text()); manifest["rootRelative"] = "../outside"
        (self.runtime / "asset-manifest.json").write_text(json.dumps(manifest))
        with self.assertRaisesRegex(ValueError, "escapes runtime"): build_portable.export_bundle(self.runtime, self.binary, Path(self.tmp.name) / "escape", expected_binary_sha256=self.expected)

    def test_rejects_changed_archive_and_malformed_gzip(self):
        path = self.runtime / "assets.tar-test.gz"; path.write_bytes(b"not-gzip")
        with self.assertRaises(Exception): build_portable.export_bundle(self.runtime, self.binary, Path(self.tmp.name) / "bad-gzip", expected_binary_sha256=self.expected)

    def test_rejects_changed_tree_against_archive(self):
        (self.assets / "payload.txt").write_text("changed\n")
        with self.assertRaisesRegex(ValueError, "does not exactly match"):
            build_portable.export_bundle(self.runtime, self.binary, Path(self.tmp.name) / "bad-tree", expected_binary_sha256=self.expected)
