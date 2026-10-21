"""Supported combinations: release coverage is full; pull requests use a smoke set."""
import json
import os

RUNNERS = ['ubuntu-24.04', 'ubuntu-24.04-arm', 'macos-15', 'macos-15-intel',
           'windows-2025', 'windows-11-arm']
NODES = ['22', '24', '26']


def matrices(full):
    runtime = [dict(runner=runner, node=node) for runner in RUNNERS for node in NODES
               if full or node == '24' or runner == 'ubuntu-24.04']
    return runtime, NODES if full else ['24']


if __name__ == '__main__':
    full = os.environ.get('GITHUB_EVENT_NAME') != 'pull_request'
    runtime, musl = matrices(full)
    with open(os.environ['GITHUB_OUTPUT'], 'a') as output:
        for key, value in [('runtime', runtime), ('musl', musl), ('coverage', 'full' if full else 'smoke')]:
            output.write(key + '=' + (value if isinstance(value, str) else json.dumps(value, separators=(',', ':'))) + '\n')
