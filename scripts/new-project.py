"""Create a new project from tracked source categories, never overwrite a directory."""
import argparse
import json
from pathlib import Path
import re
import shutil

ROOT = Path(__file__).resolve().parents[1]
CATEGORIES = ('src', 'template', 'tests', 'scripts', 'docs', '.github')
FILES = ('README.md', 'DETERMINISM.md', 'AGENTS.md', '.gitignore', 'package.json', 'package-lock.json')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('destination', type=Path)
    parser.add_argument('--name', required=True)
    args = parser.parse_args()
    if not re.fullmatch(r'[a-z][a-z0-9-]{0,63}', args.name):
        parser.error('Name must be 1–64 lowercase letters, digits or hyphens, starting with a letter')
    destination = args.destination.expanduser().resolve()
    if destination == ROOT or ROOT in destination.parents:
        parser.error('Destination must be outside this repository')
    if destination.exists():
        parser.error('Destination already exists; choose a new directory')
    inputs = [ROOT / file for file in FILES]
    for category in CATEGORIES:
        for path in (ROOT / category).rglob('*'):
            if path.is_symlink():
                parser.error(f'Symlink source is not allowed: {path}')
            if '__pycache__' not in path.parts and path.is_file():
                inputs.append(path)
    if any(path.is_symlink() or not path.is_file() for path in inputs):
        parser.error('A required source is missing or is a symlink')
    destination.mkdir(parents=True, exist_ok=False)
    for source in inputs:
        target = destination / source.relative_to(ROOT)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)
    for file in ('package.json', 'package-lock.json'):
        target = destination / file
        data = json.loads(target.read_text())
        data['name'] = args.name
        if file == 'package-lock.json':
            data['packages']['']['name'] = args.name
        target.write_text(json.dumps(data, indent=2) + '\n')
    target = destination / 'template/manifest.json'
    data = json.loads(target.read_text())
    data['name'] = args.name
    target.write_text(json.dumps(data, indent=2) + '\n')
    print(f'Created {destination}; see README.md for build and test commands')


if __name__ == '__main__':
    main()
