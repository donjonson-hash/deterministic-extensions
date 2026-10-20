"""Narrow package and architecture checks; not a general security scanner."""
from pathlib import Path
from html.parser import HTMLParser
from urllib.parse import urlparse
import hashlib
import json
import re
import subprocess
import tempfile
import zipfile
from build import ROOT, source_files, write_archive


class Links(HTMLParser):
    def __init__(self):
        super().__init__()
        self.refs, self.ids = [], []

    def handle_starttag(self, tag, attributes):
        attrs = dict(attributes)
        if 'id' in attrs:
            self.ids.append(attrs['id'])
        for name in ('src', 'href'):
            if name in attrs:
                self.refs.append(attrs[name])
        assert not any(name.startswith('on') for name in attrs), 'Inline handlers are not allowed'
        if tag == 'script':
            assert 'src' in attrs, 'Inline script is not allowed'


def main():
    files, version = source_files()
    manifest = json.loads(files['manifest.json'])
    assert manifest['manifest_version'] == 3
    assert not manifest.get('permissions') and not manifest.get('host_permissions')
    assert "connect-src 'none'" in manifest['content_security_policy']['extension_pages']
    assert manifest['background']['service_worker'] in files
    for name, data in files.items():
        if name.endswith('.html'):
            page = Links()
            page.feed(data.decode())
            assert len(page.ids) == len(set(page.ids)), (name, 'duplicate ID')
            for ref in page.refs:
                url = urlparse(ref)
                if not url.path:
                    continue
                assert not url.scheme and not url.netloc, (name, 'external resource/link', ref)
                path = (Path(name).parent / url.path).as_posix()
                assert path in files, (name, 'missing resource', ref)
        if name.endswith(('.js', '.mjs')):
            subprocess.run(['node', '--check', str(ROOT / 'dist/extension' / name)], check=True)
        if name.startswith('core/'):
            text = data.decode()
            # Regression tripwires, deliberately not a complete AST audit.
            for expression in (r'\bDate\b', r'\bperformance\s*\.', r'\bMath\s*\.\s*random',
                               r'\b(?:window|chrome|localStorage|indexedDB)\s*\.',
                               r'\bdocument\s*\.\s*(?:querySelector|getElementById|createElement|body|documentElement)\b',
                               r'\b(?:fetch|XMLHttpRequest|WebSocket|eval)\s*\(',
                               r'\.\s*localeCompare\s*\('):
                assert not re.search(expression, text), (name, 'ambient input in core', expression)
    archive = ROOT / 'dist' / f'deterministic-extension-{version}.zip'
    with zipfile.ZipFile(archive) as z:
        assert z.testzip() is None
        assert set(z.namelist()) == set(files), 'Archive closure mismatch'
        for name, data in files.items():
            assert z.read(name) == data, (name, 'payload mismatch')
            assert (ROOT / 'dist/extension' / name).read_bytes() == data
    with tempfile.TemporaryDirectory() as directory:
        second = Path(directory) / 'repeat.zip'
        write_archive(second, dict(reversed(list(files.items()))))
        assert second.read_bytes() == archive.read_bytes(), 'Packaging depends on input enumeration'
    record = json.loads((ROOT / 'dist/build-manifest.json').read_text())
    assert record['archiveSha256'] == hashlib.sha256(archive.read_bytes()).hexdigest()
    assert record['files'] == {n: hashlib.sha256(b).hexdigest() for n, b in sorted(files.items())}
    print('PASS: source boundaries, local resources, manifest, exact payload and repeatable ZIP bytes')


if __name__ == '__main__':
    main()
