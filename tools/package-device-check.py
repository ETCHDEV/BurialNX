#!/usr/bin/env python3
"""Build the optional device-check ZIP; use only the two original reference clips.
Usage: python3 tools/package-device-check.py /path/to/cg.2-SD.zip /new/path/device-check.zip
Never edits the application package, target game, or an existing output archive.
"""
import hashlib
import sys
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo

root = Path(__file__).resolve().parents[1]
release, out = map(Path, sys.argv[1:])
expected = {'mp4': '604b6fd2beeefaf8ec8b7e3381e1b56c08ed381769786aafb9d8fb2efd9240eb',
            'webm': 'f5958d48517335c61d61316e6757b32975a7766a54971b022cd0b33236ea7dd0'}
fixture = root / 'tests/fixtures/device-check/www'
prefix = 'BurialNX-CG-device-check/'
entries = {prefix + 'www/' + p: (fixture / p).read_bytes() for p in ['index.html', 'js/device-metrics.js', 'js/rpg_core.js']}
entries[prefix + '使用说明.md'] = (root / 'docs/device-check-zh.md').read_bytes()
entries[prefix + 'LICENSE.txt'] = (root / 'LICENSE').read_bytes()
with ZipFile(release) as src:
    for ext, h in expected.items():
        name = 'www/movies/sync.' + ext
        b = src.read('BurialNX-CG-check/' + name)
        if hashlib.sha256(b).hexdigest() != h:
            raise ValueError('Unexpected reference movie: ' + ext)
        entries[prefix + name] = b
with ZipFile(out, 'x') as target:
    for name in sorted(entries):
        info = ZipInfo(name, (1980,1,1,0,0,0))
        info.external_attr = 0o100644 << 16
        target.writestr(info, entries[name], compress_type=ZIP_DEFLATED, compresslevel=8)
with ZipFile(out) as z:
    if z.testzip() or set(z.namelist()) != set(entries) or any(z.read(k) != b for k,b in entries.items()):
        raise ValueError('Verification failed')
print(f'{len(entries)} files; {out.stat().st_size} bytes; SHA-256 {hashlib.sha256(out.read_bytes()).hexdigest()}')
