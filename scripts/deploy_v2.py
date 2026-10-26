#!/usr/bin/env python3
"""Deploy sakana-2api through a verified temporary release directory."""
from __future__ import annotations

import argparse
import io
import json
import os
from pathlib import Path, PurePosixPath
import posixpath
import shlex
import stat
import subprocess
import tarfile
import time

import paramiko


PROJECT_ROOT = Path(__file__).resolve().parents[1]
REMOTE = os.environ.get('SAKANA_REMOTE_DIR', '/root/sakana-2api')
RUNTIME_ROOT = os.environ.get('SAKANA_REMOTE_RUNTIME', f'{REMOTE}.runtime')
RUNTIME_STATE_BASENAMES = (
    'session.json',
    'account_pool.json',
    'account_pool.remote.json',
    'keys.json',
    'tempmail.json',
    'tokens.json',
    'mail-config.json',
    'audit-log.json',
    'yyds-domain-scores.json',
)
RUNTIME_DIR_BASENAMES = {'.browser-profile', 'character_cards'}
EXCLUDE_DIR_BASENAMES = {
    '.git', '.zcode', 'node_modules', '.playwright-mcp', '.browser-profile',
    '.chrome-sakana-profile', 'character_cards', 'runtime', '__pycache__', 'target',
}

EXCLUDE_RELATIVE_PATHS = {
    'runtime', 'scripts/.ssh_secret.json', 'scripts/.env', 'scripts/.env.local',
}
EXCLUDE_BASENAMES = set(RUNTIME_STATE_BASENAMES) | {
    '.ssh_secret.json', 'server.log', 'mailmsg.json', 'mailtoken.json',
    'success_sample.json', 'Dockerfile.local', 'private.pem', 'admin_key',
    '.admin_key', 'credentials.json', 'cookies.json',
}
EXCLUDE_SUFFIXES = (
    '.log', '.exe', '.zip', '.tar', '.tar.gz', '.tgz', '.gz', '.7z', '.rar',
    '.bak', '.db', '.sqlite', '.sqlite3', '.dump', '.pem', '.key', '.p12', '.pfx',
)
EXCLUDE_PREFIXES = (
    'raw_search', 'red', 'chunk-', 'mailmsg', 'mailtoken', 'success_sample',
    'capture_', 'scan_', 'probe_', 'replicate_', 'test_', 'dump_', 'check_',
    'ui_upload', 'brute_stream', 'tamper_test', 'net_trace', 'debug_stream',
    'harvest_session', 'find_bundle', 'firebase_login', 'node_replay_sample',
    'open_magic_link', 'click_login', 'compare_auth', 'complete_login',
    'do_login',
)


def relative_path(path: Path) -> str:
    return path.relative_to(PROJECT_ROOT).as_posix()


def is_env_file(name: str) -> bool:
    return name == '.env' or name.startswith('.env.')


def should_exclude(path: Path) -> bool:
    rel = relative_path(path)
    parts = PurePosixPath(rel).parts
    basename = PurePosixPath(rel).name
    if rel == 'runtime' or rel.startswith('runtime/'):
        return True
    if any(part in EXCLUDE_DIR_BASENAMES for part in parts):
        return True
    if rel in EXCLUDE_RELATIVE_PATHS or basename in EXCLUDE_BASENAMES:
        return True
    if basename.startswith('.') and basename not in {'.gitignore', '.dockerignore', '.gitattributes'}:
        return True
    if is_env_file(basename) or basename.endswith(EXCLUDE_SUFFIXES):
        return True
    return any(basename.startswith(prefix) for prefix in EXCLUDE_PREFIXES)


def should_exclude_dir(root: Path, dirname: str) -> bool:
    rel = relative_path(root / dirname)
    return dirname in EXCLUDE_DIR_BASENAMES or rel in EXCLUDE_RELATIVE_PATHS or rel == 'runtime'


def _tracked_paths() -> list[str]:
    try:
        result = subprocess.run(
            ['git', '-C', str(PROJECT_ROOT), 'ls-files', '-z'],
            check=True, capture_output=True,
        )
    except (OSError, subprocess.CalledProcessError) as error:
        raise RuntimeError('deployment archive requires a readable Git index') from error
    return [item.decode('utf-8') for item in result.stdout.split(b'\0') if item]


def _is_sensitive(path: str) -> bool:
    basename = PurePosixPath(path).name.lower()
    return (
        is_env_file(basename) or basename in {'.ssh_secret.json', '.admin_key', 'admin_key', 'credentials.json', 'cookies.json'}
        or basename in RUNTIME_STATE_BASENAMES
        or basename.endswith(('.pem', '.key', '.p12', '.pfx'))
    )


def _tracked_mode(rel: str) -> int:
    result = subprocess.run(
        ['git', '-C', str(PROJECT_ROOT), 'ls-files', '--stage', '--', rel],
        check=True, capture_output=True,
    ).stdout.decode('utf-8', 'replace')
    mode = result.split(None, 1)[0] if result else ''
    return 0o755 if mode == '100755' else 0o644


def build_archive(*, include: tuple[str, ...] | list[str] = ()) -> io.BytesIO:
    paths = _tracked_paths()
    for raw in include:
        candidate = PurePosixPath(raw)
        if candidate.is_absolute() or '..' in candidate.parts or not candidate.parts:
            raise RuntimeError(f'invalid explicit release path: {raw}')
        rel = candidate.as_posix()
        if should_exclude(PROJECT_ROOT / rel) or _is_sensitive(rel):
            raise RuntimeError(f'explicit release path is excluded or sensitive: {rel}')
        if not (PROJECT_ROOT / rel).is_file():
            raise RuntimeError(f'explicit release file does not exist: {rel}')
        if rel not in paths:
            paths.append(rel)

    versions = {}
    for rel in paths:
        if _is_sensitive(rel):
            raise RuntimeError(f'sensitive or runtime state file is tracked: {rel}')
        if should_exclude(PROJECT_ROOT / rel):
            continue
        if rel in {'package.json', 'package-lock.json'}:
            try:
                versions[rel] = json.loads((PROJECT_ROOT / rel).read_text(encoding='utf-8'))['version']
            except (OSError, KeyError, json.JSONDecodeError) as error:
                raise RuntimeError(f'invalid package version metadata in {rel}') from error
    if len(versions) != 2 or versions['package.json'] != versions['package-lock.json']:
        raise RuntimeError('package.json and package-lock.json versions must match')

    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode='w:gz') as archive:
        for rel in sorted(set(paths)):
            local_path = PROJECT_ROOT / rel
            if should_exclude(local_path):
                continue
            if local_path.is_symlink():
                raise RuntimeError(f'release source may not be a symlink: {rel}')
            data = local_path.read_bytes()
            if rel == '.gitattributes':
                pass
            elif local_path.suffix.lower() in {'.sh', '.py', '.js', '.mjs', '.json', '.md', '.html', '.yml', '.yaml'}:
                data = data.replace(b'\r\n', b'\n')
            info = tarfile.TarInfo(rel)
            info.size = len(data)
            info.mode = _tracked_mode(rel)
            info.mtime = 0
            archive.addfile(info, io.BytesIO(data))
    buffer.seek(0)
    return buffer


def load_credentials() -> dict:
    secret_path = Path(__file__).resolve().with_name('.ssh_secret.json')
    secret = {}
    if secret_path.exists():
        with secret_path.open(encoding='utf-8') as handle:
            secret = json.load(handle)

    def value(env_name: str, key: str, default=None):
        return os.environ.get(env_name, secret.get(key, default))

    credentials = {
        'host': value('SAKANA_SSH_HOST', 'HOST'),
        'port': int(value('SAKANA_SSH_PORT', 'PORT', 22)),
        'user': value('SAKANA_SSH_USER', 'USER'),
        'password': value('SAKANA_SSH_PASS', 'PASS'),
        'key_filename': value('SAKANA_SSH_KEY', 'KEY'),
        'known_hosts': value(
            'SAKANA_SSH_KNOWN_HOSTS',
            'KNOWN_HOSTS',
            str(Path.home() / '.ssh' / 'known_hosts'),
        ),
    }
    missing = [name for name in ('host', 'user') if not credentials[name]]
    if not credentials['password'] and not credentials['key_filename']:
        missing.append('SAKANA_SSH_PASS or SAKANA_SSH_KEY')
    if missing:
        raise RuntimeError(
            'SSH configuration is incomplete; set environment variables or scripts/.ssh_secret.json: '
            + ', '.join(missing)
        )
    known_hosts = Path(os.path.expanduser(credentials['known_hosts']))
    if not known_hosts.is_file():
        raise RuntimeError(f'SSH known_hosts file is required: {known_hosts}')
    credentials['known_hosts'] = str(known_hosts)
    if credentials['key_filename']:
        credentials['key_filename'] = str(Path(os.path.expanduser(credentials['key_filename'])))
        if not Path(credentials['key_filename']).is_file():
            raise RuntimeError(f'SSH key file does not exist: {credentials["key_filename"]}')
    return credentials


def connect(credentials: dict) -> paramiko.SSHClient:
    ssh = paramiko.SSHClient()
    ssh.load_system_host_keys()
    ssh.load_host_keys(credentials['known_hosts'])
    ssh.set_missing_host_key_policy(paramiko.RejectPolicy())
    ssh.connect(
        credentials['host'],
        credentials['port'],
        credentials['user'],
        password=credentials['password'],
        key_filename=credentials['key_filename'],
        look_for_keys=False,
        allow_agent=False,
    )
    return ssh


def q(value: str) -> str:
    return shlex.quote(value)


def runtime_prepare_command() -> str:
    return f'''set -eu
SAKANA_REMOTE={q(REMOTE)} SAKANA_RUNTIME={q(RUNTIME_ROOT)} python3 - <<'PY'
import os
from pathlib import Path
import shutil

remote = Path(os.environ['SAKANA_REMOTE'])
runtime = Path(os.environ['SAKANA_RUNTIME'])
state_names = {RUNTIME_STATE_BASENAMES!r}
directory_names = {sorted(RUNTIME_DIR_BASENAMES)!r}
runtime.mkdir(parents=True, exist_ok=True)
plans = []
def same_target(raw, source, target):
    raw_text = str(raw)
    device_prefix = chr(92) * 2 + '?' + chr(92)
    if raw_text.startswith(device_prefix) or raw_text.startswith('//?/') or os.path.isabs(raw_text):
        candidate = raw_text
    else:
        candidate = os.path.join(str(source.parent), raw_text)
    def normalize(value):
        text = str(value).replace(chr(92), '/')
        if text.startswith('//?/'):
            text = text[4:]
        return os.path.normcase(os.path.normpath(text))
    return normalize(candidate) == normalize(target)

# Refuse ambiguous links and conflicts before copying anything. Every source is
# retained so interrupted releases can be diagnosed or retried without data loss.
# Older releases left a small, known class of self-links for unused compatibility
# state files; preserve those links, while rejecting every other runtime link.
for item in runtime.iterdir():
    if item.is_symlink():
        raw = os.readlink(item)
        expected = str(item)
        if item.name not in state_names or raw != expected:
            raise RuntimeError(f'unknown or cyclic runtime symlink: {{item}}')

legacy_runtime = remote / 'runtime'
if legacy_runtime.is_symlink():
    if legacy_runtime.resolve(strict=False) != runtime.resolve(strict=False):
        raise RuntimeError(f'legacy runtime link points elsewhere: {{legacy_runtime}}')
elif legacy_runtime.exists():
    if not legacy_runtime.is_dir():
        raise RuntimeError(f'legacy runtime path is not a directory: {{legacy_runtime}}')
    for source in sorted(legacy_runtime.rglob('*')):
        if source.is_symlink():
            raise RuntimeError(f'legacy runtime contains a symlink: {{source}}')
        if source.is_file():
            target = runtime / source.relative_to(legacy_runtime)
            if target.exists():
                raise RuntimeError(f'conflicting durable state: {{target}}')
            plans.append((source, target, False))
        elif source.is_dir():
            target = runtime / source.relative_to(legacy_runtime)
            if target.exists() and not target.is_dir():
                raise RuntimeError(f'conflicting durable directory: {{target}}')

for name in state_names:
    source = remote / name
    target = runtime / name
    if source.is_symlink():
        raw = os.readlink(source)
        expected = str(target)
        if not same_target(raw, source, target):
            raise RuntimeError(f'root state link points elsewhere: {{source}}')
        continue
    if source.exists():
        if target.exists():
            raise RuntimeError(f'conflicting root and durable state: {{source}} / {{target}}')
        plans.append((source, target, False))

for name in directory_names:
    source = remote / name
    target = runtime / name
    if source.is_symlink():
        raw = os.readlink(source)
        expected = str(target)
        if not same_target(raw, source, target):
            raise RuntimeError(f'root data link points elsewhere: {{source}}')
        continue
    if source.exists():
        if not source.is_dir():
            raise RuntimeError(f'root data path is not a directory: {{source}}')
        if target.exists():
            raise RuntimeError(f'conflicting root and durable directory: {{source}} / {{target}}')
        plans.append((source, target, True))

for source, target, is_directory in plans:
    target.parent.mkdir(parents=True, exist_ok=True)
    if is_directory:
        shutil.copytree(source, target, symlinks=False)
    else:
        shutil.copy2(source, target)
PY
'''


def remote_command(ssh: paramiko.SSHClient, command: str, timeout: int = 300):
    stdin, stdout, stderr = ssh.exec_command(command, timeout=timeout)
    output = stdout.read().decode('utf-8', 'replace')
    error = stderr.read().decode('utf-8', 'replace')
    code = stdout.channel.recv_exit_status()
    return code, output, error


def upload_archive(ssh: paramiko.SSHClient, archive: io.BytesIO, path: str) -> None:
    sftp = ssh.open_sftp()
    try:
        with sftp.open(path, 'wb') as remote_archive:
            remote_archive.write(archive.read())
    finally:
        sftp.close()


def deploy(args) -> None:
    credentials = load_credentials()
    ssh = connect(credentials)
    release_id = f'{int(time.time())}-{os.getpid()}'
    stage = f'{REMOTE}.release-{release_id}'
    backup = f'{REMOTE}.previous-{release_id}'
    archive_path = f'/tmp/sakana-2api-{release_id}.tar.gz'
    archive = build_archive(include=(
        'CHANGELOG.md',
        'lib/chat-response.js',
        'lib/conversation-lock.js',
        'lib/remote-fetch.js',
    ))
    print(f'Connected to {credentials["host"]}; archive={archive.getbuffer().nbytes / 1024:.0f} KB')
    try:
        code, _, error = remote_command(ssh, f'mkdir -p {q(REMOTE)}')
        if code:
            raise RuntimeError(f'cannot create remote directory: {error.strip()}')
        code, _, error = remote_command(ssh, runtime_prepare_command())
        if code:
            raise RuntimeError(f'runtime preparation failed: {error.strip()}')

        upload_archive(ssh, archive, archive_path)
        stage_q = q(stage)
        runtime_q = q(RUNTIME_ROOT)
        names = ' '.join(q(name) for name in RUNTIME_STATE_BASENAMES)
        profile_links = '\n'.join(
            f"ln -s {runtime_q}/{q(name)} {stage_q}/{q(name)}"
            for name in sorted(RUNTIME_DIR_BASENAMES)
        )
        prepare = f'''set -eu
rm -rf {stage_q}
mkdir -p {stage_q}
tar xzf {q(archive_path)} -C {stage_q}
rm -f {q(archive_path)}
ln -s {runtime_q} {stage_q}/runtime
for name in {names}; do ln -s {runtime_q}/$name {stage_q}/$name; done
{profile_links}
cd {stage_q}
npm ci --omit=dev
node --check server.js
'''
        code, output, error = remote_command(ssh, prepare, timeout=900)
        if code:
            raise RuntimeError(f'release validation failed: {error[-1000:]}')
        print(output[-1000:])

        switch = f'''set -eu
if [ -e {q(REMOTE)} ] || [ -L {q(REMOTE)} ]; then mv {q(REMOTE)} {q(backup)}; fi
mv {stage_q} {q(REMOTE)}
'''
        code, _, error = remote_command(ssh, switch)
        if code:
            raise RuntimeError(f'release switch failed: {error.strip()}')

        if args.sanitize_pool:
            sanitize = (
                f'''set -eu
cd {q(REMOTE)}
node -e "const fs=require('fs');const p='account_pool.json';'''
                '''if(!fs.existsSync(p)){process.exit(0)};'''
                '''const a=JSON.parse(fs.readFileSync(p,'utf8'));'''
                '''a.forEach(x=>{x.uid='';x.email='';x.display='acct-'+String(x.id||'').slice(0,8)});'''
                '''fs.writeFileSync(p,JSON.stringify(a,null,2));console.log('sanitized='+a.length)"'''
            )
            code, output, error = remote_command(ssh, sanitize)
            if code:
                raise RuntimeError(f'pool sanitization failed: {error.strip()}')
            print(output.strip())

        if not args.upload_only:
            # Public bind (panel at http://<server>:8787): start_sakana.sh's
            # guard accepts the persisted runtime admin key as the required
            # credential; server.js loads it as ADMIN_API_KEY. Managed
            # business keys stay hash-only in keys.json.
            restart = f'''set -eu
if command -v ss >/dev/null 2>&1; then
  pid=$(ss -tlnp 2>/dev/null | grep ':8787' | grep -oP 'pid=\\K[0-9]+' | head -1 || true)
  if [ -n "$pid" ]; then kill "$pid" || true; fi
fi
cd {q(REMOTE)}
HOST=0.0.0.0 setsid nohup bash scripts/start_sakana.sh >/dev/null 2>&1 &
sleep 5
curl -fsS -m 15 http://127.0.0.1:8787/health
'''
            code, output, error = remote_command(ssh, restart, timeout=120)
            if code:
                raise RuntimeError(f'restart/health check failed: {error[-1000:]}')
            print('Health:', output.strip())
        else:
            print('Upload complete; restart skipped (--upload-only).')
    finally:
        ssh.close()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('--upload-only', action='store_true', help='upload and validate without restarting')
    parser.add_argument('--restart', action='store_true', help='compatibility flag; restart is the default')
    parser.add_argument('--sanitize-pool', action='store_true')
    args = parser.parse_args()
    deploy(args)


if __name__ == '__main__':
    main()
