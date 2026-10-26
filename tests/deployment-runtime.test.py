"""Offline deployment regressions. Run: python tests/deployment-runtime.test.py."""
from __future__ import annotations

import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import shlex
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch



ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('deploy_v2', ROOT / 'scripts/deploy_v2.py')
deploy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deploy)


def write(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding='utf-8', newline='')


def bash_path(path):
    # Git Bash needs POSIX paths for filesystem operations in generated shell.
    text = str(path).replace('\\', '/')
    if os.name == 'nt' and len(text) > 2 and text[1] == ':':
        return '/' + text[0].lower() + text[2:]
    return text


class ArchiveTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='sakana-artifact-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.project = patch.object(deploy, 'PROJECT_ROOT', self.root)
        self.project.start()
        self.addCleanup(self.project.stop)
        self.git('init', '-q')
        write(self.root / '.gitattributes', '*.sh text eol=lf\n*.mjs text eol=lf\n')
        write(self.root / 'package.json', json.dumps({'name': 'sakana-2api', 'version': '1.2.3'}))
        write(self.root / 'package-lock.json', json.dumps({
            'name': 'sakana-2api', 'version': '1.2.3', 'lockfileVersion': 3,
            'packages': {'': {'name': 'sakana-2api', 'version': '1.2.3'}},
        }))
        write(self.root / 'server.js', 'console.log("tracked");\n')
        write(self.root / 'scripts/start.sh', '#!/bin/bash\necho tracked\n')
        self.git('add', '.gitattributes', 'package.json', 'package-lock.json', 'server.js', 'scripts/start.sh')
        self.git('update-index', '--chmod=+x', 'scripts/start.sh')

    def git(self, *args):
        return subprocess.run(['git', '-C', str(self.root), *args], check=True, capture_output=True)

    def contents(self, **kwargs):
        with tarfile.open(fileobj=deploy.build_archive(**kwargs), mode='r:gz') as archive:
            return {item.name: (item, archive.extractfile(item).read()) for item in archive.getmembers()}

    def test_only_tracked_worktree_content_and_explicit_sources_are_archived(self):
        # A recursive filesystem walk leaks these files even with a suffix denylist.
        write(self.root / 'server.js', 'console.log("working tree change");\n')
        for name in ['local-notes.txt', 'lib/new-source.mjs', '.env', 'scripts/.ssh_secret.json',
                     '.zcode/cache.txt', '.git/private-note', 'node_modules/pkg/index.js']:
            write(self.root / name, 'private local data\n')
        contents = self.contents()
        self.assertEqual(set(contents), {'.gitattributes', 'package.json', 'package-lock.json',
                                         'server.js', 'scripts/start.sh'})
        self.assertEqual(contents['server.js'][1], b'console.log("working tree change");\n')
        contents = self.contents(include=['lib/new-source.mjs'])
        self.assertIn('lib/new-source.mjs', contents)
        self.assertNotIn('.env', contents)

    def test_git_attributes_and_index_executable_mode_survive_windows_checkout(self):
        write(self.root / 'scripts/start.sh', '#!/bin/bash\r\necho edited\r\n')
        contents = self.contents()
        self.assertEqual(contents['scripts/start.sh'][1], b'#!/bin/bash\necho edited\n')
        self.assertEqual(contents['scripts/start.sh'][0].mode, 0o755)
        self.assertEqual(contents['server.js'][0].mode, 0o644)
        self.assertIn('.gitattributes', contents)

    def test_tracked_secrets_fail_before_credentials_are_read(self):
        for name in ['.env.production', 'scripts/.ssh_secret.json', 'keys.json',
                     'scripts/.admin_key', 'private.pem']:
            with self.subTest(name=name):
                write(self.root / name, 'fixture secret')
                self.git('add', '-f', name)
                with self.assertRaisesRegex(RuntimeError, '(?i)secret|sensitive|credential|state'):
                    deploy.build_archive()
                self.git('rm', '--cached', '-q', '--', name)
                (self.root / name).unlink()

    def test_explicit_includes_cannot_bypass_exclusions_or_escape_project(self):
        write(self.root / '.env', 'fixture secret')
        for name in ['.env', '.git/config', '../outside.js', '/tmp/outside.js', 'scripts', 'lib/*.mjs']:
            with self.subTest(name=name), self.assertRaises((RuntimeError, ValueError)):
                deploy.build_archive(include=[name])

    def test_cache_directories_are_excluded_even_if_accidentally_tracked(self):
        for name in ['.zcode/cache.txt', 'native/target/cache', 'node_modules/x.js']:
            write(self.root / name, 'cache')
            self.git('add', '-f', name)
        self.assertFalse(any('cache' in name or 'node_modules' in name for name in self.contents()))

    def test_version_mismatch_is_rejected_without_mutating_metadata(self):
        write(self.root / 'package.json', '{"name":"sakana-2api","version":"2.0.0"}')
        before = (self.root / 'package-lock.json').read_bytes()
        with self.assertRaisesRegex(RuntimeError, '(?i)version|metadata'):
            deploy.build_archive()
        self.assertEqual((self.root / 'package-lock.json').read_bytes(), before)


class RuntimeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='sakana-runtime-')
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.live = self.base / 'live release'
        self.runtime = self.base / 'durable state'
        self.live.mkdir()
        self.remote = patch.object(deploy, 'REMOTE', str(self.live))
        self.durable = patch.object(deploy, 'RUNTIME_ROOT', str(self.runtime))
        self.remote.start()
        self.durable.start()
        self.addCleanup(self.remote.stop)
        self.addCleanup(self.durable.stop)

    def run_migration(self, *, fail_copy=False):
        # Execute the actual generated command, including shell quoting and heredoc.
        command = deploy.runtime_prepare_command()
        python = shlex.quote(sys.executable)
        command = command.replace('python3 - <<', f'{python} - <<')
        if fail_copy:
            # Inject failure at the real filesystem-copy boundary, without mocking migration logic.
            command = command.replace('import shutil', 'import shutil\n'
                'def fail_copy(*args, **kwargs):\n    raise OSError("injected copy failure")\n'
                'shutil.copy2 = fail_copy', 1)
        result = subprocess.run([shutil.which('bash') or 'bash', '-s'], input=command,
                                text=True, capture_output=True, timeout=30,
                                env={**os.environ, 'PYTHONUTF8': '1'})
        return result

    def assert_failed(self, result):
        self.assertNotEqual(result.returncode, 0, result.stdout)

    def link(self, path, target):
        try:
            path.symlink_to(target, target_is_directory=Path(target).is_dir())
        except OSError as error:
            self.skipTest(f'OS does not permit native symlinks: {error}')

    def test_conflicting_root_state_is_preserved_on_both_sides(self):
        write(self.live / 'session.json', 'legacy session')
        write(self.runtime / 'session.json', 'durable session')
        result = self.run_migration()
        self.assert_failed(result)
        self.assertEqual((self.live / 'session.json').read_text(), 'legacy session')
        self.assertEqual((self.runtime / 'session.json').read_text(), 'durable session')

    def test_conflicting_nested_runtime_is_preserved_before_any_copy(self):
        write(self.live / 'runtime/a-new.json', 'new legacy file')
        write(self.live / 'runtime/config/state', 'legacy')
        write(self.runtime / 'config/state', 'durable')
        result = self.run_migration()
        self.assert_failed(result)
        self.assertEqual((self.live / 'runtime/config/state').read_text(), 'legacy')
        self.assertEqual((self.runtime / 'config/state').read_text(), 'durable')
        self.assertFalse((self.runtime / 'a-new.json').exists(), 'preflight must precede writes')

    def test_copy_failure_leaves_legacy_runtime_and_root_files_intact(self):
        write(self.live / 'runtime/env.sh', 'legacy env')
        write(self.live / 'session.json', 'legacy session')
        result = self.run_migration(fail_copy=True)
        self.assert_failed(result)
        self.assertEqual((self.live / 'runtime/env.sh').read_text(), 'legacy env')
        self.assertEqual((self.live / 'session.json').read_text(), 'legacy session')
        self.assertFalse((self.runtime / 'env.sh').exists())

    def test_legacy_data_and_character_cards_are_copied_without_removing_sources(self):
        write(self.live / 'runtime/env.sh', 'export TEST=fixture\n')
        write(self.live / 'session.json', 'session')
        write(self.live / 'character_cards/card.json', 'card')
        write(self.live / '.browser-profile/Default/Preferences', 'profile')
        result = self.run_migration()
        self.assertEqual(result.returncode, 0, result.stderr)
        for source, target in [('runtime/env.sh', 'env.sh'), ('session.json', 'session.json'),
                               ('character_cards/card.json', 'character_cards/card.json'),
                               ('.browser-profile/Default/Preferences', '.browser-profile/Default/Preferences')]:
            self.assertEqual((self.live / source).read_bytes(), (self.runtime / target).read_bytes())

    def test_existing_normal_root_links_are_accepted_without_altering_them(self):
        write(self.runtime / 'session.json', 'durable')
        (self.runtime / 'character_cards').mkdir()
        self.link(self.live / 'runtime', self.runtime)
        self.link(self.live / 'session.json', self.runtime / 'session.json')
        self.link(self.live / 'tokens.json', self.runtime / 'tokens.json')  # expected, not yet created
        self.link(self.live / 'character_cards', self.runtime / 'character_cards')
        result = self.run_migration()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue((self.live / 'tokens.json').is_symlink())
        self.assertEqual((self.runtime / 'session.json').read_text(), 'durable')

    def test_unknown_dangling_and_looping_runtime_links_are_never_removed(self):
        self.runtime.mkdir()
        for name, target in [('unknown', 'missing'), ('session.json', 'session.json')]:
            with self.subTest(name=name):
                self.link(self.runtime / name, target)
                write(self.live / 'session.json', 'legacy session')
                result = self.run_migration()
                self.assert_failed(result)
                self.assertTrue((self.runtime / name).is_symlink())
                self.assertEqual(os.readlink(self.runtime / name), target)
                self.assertEqual((self.live / 'session.json').read_text(), 'legacy session')
                (self.runtime / name).unlink()  # fixture cleanup only

    def test_unknown_root_link_is_preserved(self):
        self.link(self.live / 'session.json', self.base / 'missing-other-state')
        result = self.run_migration()
        self.assert_failed(result)
        self.assertTrue((self.live / 'session.json').is_symlink())
        self.assertFalse((self.runtime / 'session.json').exists())


if __name__ == '__main__':
    unittest.main(verbosity=2)
