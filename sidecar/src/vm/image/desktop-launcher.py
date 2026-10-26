"""The panel can launch only these two unprivileged applications, never a shell string."""
import os
import signal
import socket
import subprocess
import time

path = '/run/touri-desktop/launcher'
try:
    os.unlink(path)
except FileNotFoundError:
    pass
launcher = socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM)
launcher.bind(path)
os.chown(path, 0, 1001)
os.chmod(path, 0o620)
# Bind in the root-owned directory before permanently dropping all privileges.
# The agent cannot replace the socket that the trusted panel writes to.
os.setgroups([])
os.setgid(1000)
os.setuid(1000)
os.environ.update(HOME='/workspace/.home', DISPLAY=':99',
                  XAUTHORITY='/run/touri-desktop/authority', LANG='C.UTF-8',
                  SHELL='/bin/bash', PS1=r'\[\033[32m\]\u@\h:\w\$\[\033[0m\] ')
os.chdir('/workspace/.home')
signal.signal(signal.SIGCHLD, signal.SIG_IGN)
commands = {b'terminal': ['/bin/sh', '/usr/local/lib/touri/terminal.sh'],
            b'files': ['pcmanfm', '/workspace']}

def launch(command):
    subprocess.Popen(command, stdin=subprocess.DEVNULL, start_new_session=True)

launch(commands[b'terminal'])
last_launch = 0
while True:
    command = commands.get(launcher.recv(32))
    now = time.monotonic()
    if command is None or now - last_launch < 0.25:
        continue
    last_launch = now
    launch(command)
