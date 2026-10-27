import { expect, test } from "bun:test"
import { BROWSER_FLAGS } from "../../src/vm/browser-launch"

// Import the production Python module without starting its privileged entry point.
const getResult = async (source: string): Promise<string> => {
  const child = Bun.spawn(
    [
      "python3",
      "-B",
      "-c",
      `import importlib.util, subprocess\nfrom unittest.mock import Mock, patch, mock_open\nfrom contextlib import nullcontext\nspec = importlib.util.spec_from_file_location('dock', 'sidecar/src/vm/image/desktop-launcher.py')\ndock = importlib.util.module_from_spec(spec)\nspec.loader.exec_module(dock)\n${source}`,
    ],
    { stdout: "pipe", stderr: "pipe" },
  )
  const [output, error, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  expect(error).toBe("")
  expect(code).toBe(0)

  return output.trim()
}

test("an existing browser window is restored and focused without launching a second browser", async () => {
  const result =
    await getResult(`run = Mock(side_effect=[subprocess.CompletedProcess([], 0, b'427\\n428\\n'), subprocess.CompletedProcess([], 0, b'_NET_CLIENT_LIST_STACKING(WINDOW): window id # 0x1ab'), subprocess.CompletedProcess([], 0)])
spawn = Mock()
with patch.object(dock, 'lock_browser', return_value=nullcontext()):
 dock.open_browser([], run=run, spawn=spawn)
assert run.call_args_list[0].args[0] == ['xdotool', 'search', '--class', '^chromium$']
assert run.call_args_list[1].args[0] == ['xprop', '-root', '_NET_CLIENT_LIST_STACKING']
assert run.call_args_list[2].args[0] == ['xdotool', 'windowactivate', '--sync', '427']
assert run.call_args_list[2].kwargs['timeout'] == 2
spawn.assert_not_called()
print('focused')`)

  expect(result).toBe("focused")
})

test("a closed browser starts with the bot flags and private profile, without a shell", async () => {
  const result =
    await getResult(`run = Mock(side_effect=[subprocess.CompletedProcess([], 1, b''), subprocess.CompletedProcess([], 1, b'')])
spawn = Mock()
with patch.object(dock, 'clear_profile_locks') as clear, patch('builtins.open', mock_open()), patch.object(dock, 'lock_browser', return_value=nullcontext()), patch.object(dock, 'wait_for_browser'):
 dock.open_browser(${JSON.stringify(BROWSER_FLAGS)}, run=run, spawn=spawn)
 clear.assert_called_once()
assert spawn.call_args.args[0] == ['chromium', *${JSON.stringify(BROWSER_FLAGS)}]
assert 'shell' not in spawn.call_args.kwargs
assert spawn.call_args.kwargs['start_new_session'] is True
print('started')`)

  expect(result).toBe("started")
})

test("a concurrent browser startup never has its live profile locks removed", async () => {
  const result =
    await getResult(`run = Mock(side_effect=[subprocess.CompletedProcess([], 1, b''), subprocess.CompletedProcess([], 0, b'123')])
with patch.object(dock, 'clear_profile_locks') as clear, patch('builtins.open', mock_open()), patch.object(dock, 'lock_browser', return_value=nullcontext()), patch.object(dock, 'wait_for_browser'):
 dock.open_browser([], run=run, spawn=Mock())
 clear.assert_not_called()
print('preserved')`)

  expect(result).toBe("preserved")
})

test("agent applications never receive trusted browser display authorization", async () => {
  const result = await getResult(`agent = dock.get_environment(browser=False)
browser = dock.get_environment(browser=True)
assert agent['XAUTHORITY'] == '/run/touri-desktop/authority'
assert agent['HOME'] == '/workspace/.home'
assert browser['XAUTHORITY'] == '/var/lib/touri-browser/.Xauthority'
assert browser['HOME'] == '/var/lib/touri-browser'
assert set(dock.COMMANDS) == {b'terminal', b'files'}
print('isolated')`)

  expect(result).toBe("isolated")
})

test("dock and automation startup exclude each other through the same private lock", async () => {
  const result = await getResult(`import tempfile, sys, os
with tempfile.TemporaryDirectory() as directory:
 path = directory + '/launch.lock'
 child_code = '''import os,fcntl,sys,importlib.util
spec=importlib.util.spec_from_file_location('dock','sidecar/src/vm/image/desktop-launcher.py')
dock=importlib.util.module_from_spec(spec);spec.loader.exec_module(dock)
fd=os.open(sys.argv[1],os.O_RDWR)
try: fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB);raise AssertionError('startup not serialized')
except BlockingIOError: print('blocked',flush=True)
os.close(fd)
with dock.lock_browser(sys.argv[1]): print('acquired',flush=True)
'''
 with dock.lock_browser(path):
  child = subprocess.Popen([sys.executable, '-B', '-c', child_code, path], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
  assert child.stdout.readline().strip() == 'blocked'
 output, error = child.communicate(timeout=5)
 assert child.returncode == 0, error
 assert output.strip() == 'acquired'
 assert os.stat(path).st_mode & 0o777 == 0o600
print('serialized')`)

  expect(result).toBe("serialized")
})
