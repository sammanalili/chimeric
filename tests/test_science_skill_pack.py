import importlib.util
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('science_pack', ROOT / 'tools/bundled_science_skills.py')
pack = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pack)

class SciencePackTests(unittest.TestCase):
    def fixture(self, root):
        for name in pack.NAMES:
            directory = root / name
            directory.mkdir()
            (directory / 'SKILL.md').write_text('---\nname: ' + name + '\ndescription: Generic scientific task.\n---\nUse supplied sources.\n')

    def test_release_contains_only_four_generic_text_skills(self):
        resources = pack.skill_resources(ROOT / 'resources/skills')
        self.assertEqual(len([name for name in resources if name.endswith('/SKILL.md')]), 4)
        self.assertEqual({name.split('/')[2] for name in resources}, set(pack.NAMES))
        self.assertTrue(all(name.endswith('.md') for name in resources))
        text = '\n'.join(value.decode() for value in resources.values())
        for marker in ['/Users/', 'riken.sam', 'NC/Nga', 'TRBV26', 'Derm1', 'B6 mice', 'MSM mice']:
            self.assertNotIn(marker, text)

    def test_unreviewed_assets_and_data_cannot_enter_bundle(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); self.fixture(root)
            (root / pack.NAMES[0] / 'private-example.csv').write_text('private,data\n')
            with self.assertRaisesRegex(ValueError, 'Only reviewed'):
                pack.skill_resources(root)

    def test_symlinked_skill_directory_is_rejected(self):
        with tempfile.TemporaryDirectory() as temporary, tempfile.TemporaryDirectory() as outside:
            root = Path(temporary); self.fixture(root)
            directory = root / pack.NAMES[0]
            (directory / 'SKILL.md').unlink(); directory.rmdir(); directory.symlink_to(outside, target_is_directory=True)
            with self.assertRaisesRegex(ValueError, 'unsafe'):
                pack.skill_resources(root)

    def test_missing_entrypoint_is_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); self.fixture(root)
            (root / pack.NAMES[2] / 'SKILL.md').unlink()
            with self.assertRaisesRegex(ValueError, 'missing'):
                pack.skill_resources(root)

if __name__ == '__main__':
    unittest.main()
