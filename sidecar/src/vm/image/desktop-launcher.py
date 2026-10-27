"""Fixed desktop requests, split between trusted browser and untrusted agent identities."""
from contextlib import contextmanager
import fcntl
import json
import os
import signal
import socket
import subprocess
import sys
import time
import urllib.request

DIRECTORY = '/usr/local/lib/touri'
COMMANDS = {b'terminal': ['/bin/sh', DIRECTORY + '/terminal.sh'],
            b'files': ['pcmanfm', '/workspace']}


def start_desktop():
    path = '/run/touri-desktop/launcher'
    try:
        os.unlink(path)
    except FileNotFoundError:
        pass
    launcher = socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM)
    launcher.bind(path)
    os.chown(path, 0, 1001)
    os.chmod(path, 0o620)
    trusted, agent = socket.socketpair(socket.AF_UNIX, socket.SOCK_DGRAM)
    if os.fork() == 0:
        launcher.close()
        trusted.close()
        start_agent(agent)
        return

    agent.close()
    # No process serving desktop requests retains root. The agent worker never
    # inherits the trusted environment, browser socket or browser credentials.
    os.setgroups([])
    os.setgid(1001)
    os.setuid(1001)
    os.environ.clear()
    os.environ.update(get_environment(browser=True))
    with open(DIRECTORY + '/browser-flags.json') as source:
        flags = json.load(source)

    last_launch = 0
    while True:
        request = launcher.recv(32)
        now = time.monotonic()
        if request not in (*COMMANDS, b'chrome') or now - last_launch < 0.25:
            continue
        last_launch = now
        if request != b'chrome':
            trusted.send(request)
            continue
        try:
            open_browser(flags)
        except (OSError, subprocess.SubprocessError):
            # Diagnostics stay generic; browser output and profile stay private.
            print('Browser launch failed', flush=True)


def start_agent(channel):
    os.setgroups([])
    os.setgid(1000)
    os.setuid(1000)
    os.environ.clear()
    os.environ.update(get_environment(browser=False))
    os.chdir('/workspace/.home')
    signal.signal(signal.SIGCHLD, signal.SIG_IGN)
    launch(COMMANDS[b'terminal'])
    while True:
        command = COMMANDS.get(channel.recv(32))
        if command is not None:
            launch(command)


def get_environment(browser):
    return {'HOME': '/var/lib/touri-browser' if browser else '/workspace/.home',
            'DISPLAY': ':99', 'LANG': 'C.UTF-8', 'SHELL': '/bin/bash',
            'PATH': '/usr/local/bin:/usr/bin:/bin',
            'XAUTHORITY': '/var/lib/touri-browser/.Xauthority' if browser else '/run/touri-desktop/authority',
            'PS1': r'\[\033[32m\]\u@\h:\w\$\[\033[0m\] '}


def open_browser(flags, run=subprocess.run, spawn=subprocess.Popen):
    with lock_browser():
        if focus_browser(run):
            return
        start_browser_process(flags, run, spawn)


def focus_browser(run):
    windows = run(['xdotool', 'search', '--class', '^chromium$'],
                  capture_output=True, timeout=2)
    candidates = {int(window) for window in windows.stdout.splitlines() if window.isdigit()}
    if not candidates:
        return False
    # Chromium also owns invisible helper windows. Only the window manager's
    # client list identifies actual windows, including minimized ones.
    clients = run(['xprop', '-root', '_NET_CLIENT_LIST_STACKING'], capture_output=True, timeout=2)
    identifiers = clients.stdout.partition(b'#')[2].split(b',')
    managed = [int(window.strip(), 16) for window in identifiers if window.strip().startswith(b'0x')]
    window = next((window for window in reversed(managed) if window in candidates), None)
    if window is None:
        return False
    run(['xdotool', 'windowactivate', '--sync', str(window)],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=2, check=True)
    return True


def start_browser_process(flags, run=subprocess.run, spawn=subprocess.Popen):
    # Chromium's profile singleton also serializes a simultaneous bot launch.
    # Clear stale boot locks only when that identity has no live browser.
    running = run(['pgrep', '-u', '1001', '-x', 'chromium'], capture_output=True, timeout=2)
    if running.returncode != 0:
        clear_profile_locks()
    with open('/var/lib/touri-browser/chromium.log', 'ab') as log:
        spawn(['chromium', *flags], stdin=subprocess.DEVNULL, stdout=log, stderr=log,
              start_new_session=True)
    wait_for_browser()


@contextmanager
def lock_browser(path='/var/lib/touri-browser/launch.lock'):
    # Shared by the dock and automation: neither can unlink a live startup's
    # singleton files, even before Chromium has created its first process.
    descriptor = os.open(path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    deadline = time.monotonic() + 12
    try:
        while True:
            try:
                fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    raise TimeoutError('Browser startup busy')
                time.sleep(0.1)
        yield
    finally:
        os.close(descriptor)


def is_browser_ready():
    try:
        with urllib.request.urlopen('http://127.0.0.1:9222/json/version', timeout=0.5) as response:
            return response.status == 200
    except OSError:
        return False


def wait_for_browser():
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        if is_browser_ready():
            return
        time.sleep(0.1)
    raise TimeoutError('Browser did not start')


def start_browser():
    if os.getuid() != 1001:
        raise PermissionError('Browser identity required')
    with open(DIRECTORY + '/browser-flags.json') as source:
        flags = json.load(source)
    with lock_browser():
        if is_browser_ready():
            return
        start_browser_process(flags)


def clear_profile_locks():
    try:
        directory = os.open('/var/lib/touri-browser/profile', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    except FileNotFoundError:
        return
    try:
        for name in ('SingletonLock', 'SingletonSocket', 'SingletonCookie'):
            try:
                os.unlink(name, dir_fd=directory)
            except FileNotFoundError:
                pass
    finally:
        os.close(directory)


def launch(command):
    subprocess.Popen(command, stdin=subprocess.DEVNULL, start_new_session=True)


if __name__ == '__main__':
    if sys.argv[1:] == ['--start-browser']:
        start_browser()
    elif len(sys.argv) == 1:
        start_desktop()
    else:
        sys.exit(2)
