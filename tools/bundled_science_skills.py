"""Read only the four generic, text-only scientific skills shipped by Chimeric."""
from pathlib import Path
import re

NAMES = ('scientific-writing', 'scientific-data-visualization', 'scientific-illustration', 'scientific-documents')

def skill_resources(root: Path) -> dict[str, bytes]:
    if root.is_symlink() or not root.is_dir():
        raise ValueError('Bundled scientific skills directory is missing or unsafe')
    if {p.name for p in root.iterdir()} != set(NAMES):
        raise ValueError('The scientific pack must contain exactly the four generic skills')
    result = {}
    for name in NAMES:
        directory = root / name
        if directory.is_symlink() or not directory.is_dir():
            raise ValueError('A bundled scientific skill directory is unsafe')
        for path in sorted(directory.rglob('*')):
            if path.is_symlink():
                raise ValueError('Bundled scientific skills cannot contain symlinks')
            if path.is_dir():
                continue
            rel = path.relative_to(directory)
            if not path.is_file() or not (str(rel) == 'SKILL.md' or len(rel.parts) == 2 and rel.parts[0] == 'references' and rel.suffix == '.md'):
                raise ValueError('Only reviewed skill instructions and Markdown references may be bundled')
            data = path.read_bytes()
            data.decode('utf-8')
            result['./skills/' + name + '/' + rel.as_posix()] = data
        entry = result.get('./skills/' + name + '/SKILL.md')
        if entry is None or not re.search(r'^name:\s*' + re.escape(name) + r'\s*$', entry.decode(), re.M):
            raise ValueError('A scientific skill entrypoint is missing or misnamed')
    if sum(map(len, result.values())) > 512 * 1024:
        raise ValueError('The compact scientific skill pack exceeds its text budget')
    return result
