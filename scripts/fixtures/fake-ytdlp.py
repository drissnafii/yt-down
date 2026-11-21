#!/usr/bin/python3
"""Local-only fixture for the real GJS worker. Never contacts a website."""
import json
import os
import pathlib
import signal
import subprocess
import sys
import time

args = sys.argv[1:]
root = pathlib.Path(os.environ['YT_DOWN_TEST_DIR'])
with (root / 'calls.jsonl').open('a') as log:
    log.write(json.dumps(args) + '\n')
if '-j' in args:
    if os.environ.get('YT_DOWN_TEST_METADATA_FAIL'):
        print('ERROR: Unsupported URL', file=sys.stderr)
        sys.exit(1)
    print(json.dumps({'id': 'fixture', 'title': 'Local fixture', 'duration': 1,
        'webpage_url': args[-1], 'formats': [
            {'format_id': 'video', 'ext': 'mp4', 'height': 720, 'vcodec': 'h264', 'acodec': 'aac', 'filesize': 2048},
            {'format_id': 'audio', 'ext': 'm4a', 'vcodec': 'none', 'acodec': 'aac', 'abr': 128}]}), flush=True)
    sys.exit(0)
if '--load-info-json' in args:
    snapshot = pathlib.Path(args[args.index('--load-info-json') + 1])
    (root / 'snapshot.json').write_text(json.dumps({'path': str(snapshot),
        'mode': snapshot.stat().st_mode & 0o777, 'info': json.loads(snapshot.read_text())}))
failures = int(os.environ.get('YT_DOWN_TEST_FAILURES', '0'))
attempt_file = root / 'attempts'
attempts = int(attempt_file.read_text()) if attempt_file.exists() else 0
attempt_file.write_text(str(attempts + 1))
if attempts < failures:
    print('ERROR: ' + os.environ.get('YT_DOWN_TEST_ERROR', 'HTTP Error 403: Forbidden'), file=sys.stderr)
    sys.exit(1)
if os.environ.get('YT_DOWN_TEST_HANG'):
    ignore = os.environ.get('YT_DOWN_TEST_IGNORE_SIGNALS')
    code = 'import time; time.sleep(60)'
    if ignore:
        code = 'import signal,time; signal.signal(signal.SIGINT,signal.SIG_IGN); signal.signal(signal.SIGTERM,signal.SIG_IGN); time.sleep(60)'
    child = subprocess.Popen([sys.executable, '-c', code])
    (root / 'child.pid').write_text(str(child.pid))
    def stop(*_):
        try:
            child.wait(timeout=2)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait()
        sys.exit(130)
    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGTERM, stop)
    if ignore:
        signal.signal(signal.SIGINT, signal.SIG_IGN)
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        time.sleep(0.1)
print('yt-down-progress:' + json.dumps({'downloaded_bytes': 1024, 'total_bytes': 2048, 'speed': 1024, 'eta': 1}), flush=True)
if os.environ.get('YT_DOWN_TEST_HANG'):
    time.sleep(60)
output = pathlib.Path(args[args.index('--paths') + 1]) / 'fixture.mp4'
output.write_bytes(bytes(2048))
print('yt-down-file:' + json.dumps(str(output)), flush=True)
