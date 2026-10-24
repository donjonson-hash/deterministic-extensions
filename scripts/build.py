"""Build the reference extension without transformations or environment timestamps."""
from pathlib import Path
import hashlib
import json
import shutil
import zipfile

ROOT = Path(__file__).resolve().parents[1]


def source_files():
    files = {}
    for directory, prefix in ((ROOT / 'template', ''), (ROOT / 'src/core', 'core/')):
        for path in sorted(directory.rglob('*')):
            if path.is_symlink():
                raise ValueError(f'Symlinks are not allowed in extension inputs: {path}')
            if path.is_file():
                name = prefix + path.relative_to(directory).as_posix()
                if name in files:
                    raise ValueError(f'Duplicate packaged path: {name}')
                files[name] = path.read_bytes()
    manifest = json.loads(files['manifest.json'])
    version = json.loads((ROOT / 'package.json').read_text())['version']
    assert manifest['version'] == version, 'Manifest and package versions must agree'
    return files, version


def write_archive(destination, files):
    # STORE deliberately avoids compression-library differences between machines.
    with zipfile.ZipFile(destination, 'w', compression=zipfile.ZIP_STORED) as archive:
        for name, data in sorted(files.items()):
            info = zipfile.ZipInfo(name, date_time=(2026, 1, 1, 0, 0, 0))
            info.create_system = 3
            info.external_attr = 0o100644 << 16
            info.compress_type = zipfile.ZIP_STORED
            archive.writestr(info, data)


def project_files():
    names = ['package.json', 'README.md', 'docs/PROJECT-PILOT.md',
             'scripts/project-server.mjs', 'scripts/project-demo.mjs']
    for directory in ('src/core', 'src/project', 'project-ui'):
        names.extend(p.relative_to(ROOT).as_posix() for p in (ROOT / directory).rglob('*') if p.is_file())
    files = {}
    for name in sorted(names):
        path = ROOT / name
        if path.is_symlink():
            raise ValueError(f'Symlink in project pilot: {name}')
        files[name] = path.read_bytes()
    return files


def build():
    files, version = source_files()
    output = ROOT / 'dist'
    if output.is_symlink():
        raise ValueError('Refusing a symlink at dist')
    if output.exists():
        shutil.rmtree(output)
    extension = output / 'extension'
    extension.mkdir(parents=True)
    for name, data in sorted(files.items()):
        target = extension / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
    archive = output / f'deterministic-extension-{version}.zip'
    write_archive(archive, files)
    record = {
        'schemaVersion': 1,
        'version': version,
        'archive': archive.name,
        'archiveSha256': hashlib.sha256(archive.read_bytes()).hexdigest(),
        'files': {name: hashlib.sha256(data).hexdigest() for name, data in sorted(files.items())},
    }
    (output / 'build-manifest.json').write_text(json.dumps(record, sort_keys=True, indent=2) + '\n')
    pilot_files = project_files()
    pilot_archive = output / f'project-pilot-{version}.zip'
    write_archive(pilot_archive, pilot_files)
    (output / 'project-build-manifest.json').write_text(json.dumps({
        'schemaVersion': 1, 'version': version, 'archive': pilot_archive.name,
        'archiveSha256': hashlib.sha256(pilot_archive.read_bytes()).hexdigest(),
        'files': {n: hashlib.sha256(b).hexdigest() for n, b in sorted(pilot_files.items())},
    }, sort_keys=True, indent=2) + '\n')
    print(archive)
    print(pilot_archive)


if __name__ == '__main__':
    build()
