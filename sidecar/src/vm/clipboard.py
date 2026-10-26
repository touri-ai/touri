"""Paste UTF-8 into the guest's focused X11 application. No shell or host clipboard."""
import ctypes as C
import ctypes.util
import os
import select
import subprocess
import sys
import time


class SelectionRequest(C.Structure):
    _fields_ = [('type', C.c_int), ('serial', C.c_ulong), ('send_event', C.c_int),
                ('display', C.c_void_p), ('owner', C.c_ulong), ('requestor', C.c_ulong),
                ('selection', C.c_ulong), ('target', C.c_ulong), ('property', C.c_ulong),
                ('time', C.c_ulong)]


class SelectionNotify(C.Structure):
    _fields_ = [('type', C.c_int), ('serial', C.c_ulong), ('send_event', C.c_int),
                ('display', C.c_void_p), ('requestor', C.c_ulong), ('selection', C.c_ulong),
                ('target', C.c_ulong), ('property', C.c_ulong), ('time', C.c_ulong)]


class Event(C.Union):
    _fields_ = [('type', C.c_int), ('request', SelectionRequest),
                ('notify', SelectionNotify), ('padding', C.c_long * 24)]


x = C.CDLL(ctypes.util.find_library('X11'))
xt = C.CDLL(ctypes.util.find_library('Xtst'))
for name, result, args in [
    ('XOpenDisplay', C.c_void_p, [C.c_char_p]),
    ('XDefaultRootWindow', C.c_ulong, [C.c_void_p]),
    ('XCreateSimpleWindow', C.c_ulong, [C.c_void_p, C.c_ulong, C.c_int, C.c_int, C.c_uint, C.c_uint, C.c_uint, C.c_ulong, C.c_ulong]),
    ('XInternAtom', C.c_ulong, [C.c_void_p, C.c_char_p, C.c_int]),
    ('XSetSelectionOwner', C.c_int, [C.c_void_p, C.c_ulong, C.c_ulong, C.c_ulong]),
    ('XGetSelectionOwner', C.c_ulong, [C.c_void_p, C.c_ulong]),
    ('XKeysymToKeycode', C.c_uint, [C.c_void_p, C.c_ulong]),
    ('XChangeProperty', C.c_int, [C.c_void_p, C.c_ulong, C.c_ulong, C.c_ulong, C.c_int, C.c_int, C.c_void_p, C.c_int]),
    ('XSendEvent', C.c_int, [C.c_void_p, C.c_ulong, C.c_int, C.c_long, C.POINTER(Event)]),
    ('XPending', C.c_int, [C.c_void_p]),
    ('XNextEvent', C.c_int, [C.c_void_p, C.POINTER(Event)]),
    ('XConnectionNumber', C.c_int, [C.c_void_p]),
    ('XFlush', C.c_int, [C.c_void_p]),
    ('XCloseDisplay', C.c_int, [C.c_void_p]),
]:
    function = getattr(x, name)
    function.restype, function.argtypes = result, args
xt.XTestFakeKeyEvent.argtypes = [C.c_void_p, C.c_uint, C.c_int, C.c_ulong]

display = x.XOpenDisplay(os.environ.get('DISPLAY', ':99').encode())
if not display:
    raise RuntimeError('Display do guest indisponível')
input_display = display
terminal = False
# The selection must share the focused application's trust level. Keep input
# injection on the private connection; never give the shell that credential.
focus = subprocess.run(['xdotool', 'getwindowfocus', 'getwindowpid'], capture_output=True, timeout=2)
if focus.returncode == 0 and focus.stdout.strip().isdigit():
    process = '/proc/' + focus.stdout.decode().strip()
    terminal = open(process + '/comm').read(128).strip() == 'xterm'
    if os.stat(process).st_uid == 1000:
        os.environ['XAUTHORITY'] = '/run/touri-desktop/authority'
        display = x.XOpenDisplay(os.environ.get('DISPLAY', ':99').encode())
        if not display:
            x.XCloseDisplay(input_display)
            raise RuntimeError('Área de trabalho indisponível')
try:
    window = x.XCreateSimpleWindow(display, x.XDefaultRootWindow(display), 0, 0, 1, 1, 0, 0, 0)
    clipboard, utf8, targets, string = [x.XInternAtom(display, name, 0) for name in [b'CLIPBOARD', b'UTF8_STRING', b'TARGETS', b'STRING']]
    text = sys.argv[1]
    x.XSetSelectionOwner(display, clipboard, window, 0)
    x.XFlush(display)
    if x.XGetSelectionOwner(display, clipboard) != window:
        raise RuntimeError('Não foi possível preparar a colagem no guest')
    ctrl, shift, v = [x.XKeysymToKeycode(input_display, symbol) for symbol in [0xffe3, 0xffe1, ord('v')]]
    # A shell binds Ctrl+V to literal-next-character; ordinary applications use
    # Ctrl+V, while the terminal launcher configures Ctrl+Shift+V for paste.
    keys = [(ctrl, 1)] + ([(shift, 1)] if terminal else []) + [(v, 1), (v, 0)] + ([(shift, 0)] if terminal else []) + [(ctrl, 0)]
    for key, down in keys:
        xt.XTestFakeKeyEvent(input_display, key, down, 0)
    x.XFlush(input_display)
    deadline, served = time.monotonic() + 4, False
    while time.monotonic() < deadline:
        if not x.XPending(display):
            select.select([x.XConnectionNumber(display)], [], [], max(0, deadline - time.monotonic()))
            continue
        event = Event()
        x.XNextEvent(display, C.byref(event))
        if event.type != 30:  # SelectionRequest
            continue
        request = event.request
        prop = request.property or request.target
        if request.target == targets:
            data = (C.c_ulong * 3)(targets, utf8, string)
            x.XChangeProperty(display, request.requestor, prop, 4, 32, 0, data, 3)
        elif request.target in (utf8, string):
            data = text.encode('utf-8') if request.target == utf8 else text.encode('latin-1', 'replace')
            x.XChangeProperty(display, request.requestor, prop, request.target, 8, 0, C.c_char_p(data), len(data))
            served = True
            deadline = min(deadline, time.monotonic() + 0.2)
        else:
            prop = 0
        reply = Event()
        reply.notify = SelectionNotify(31, 0, 1, display, request.requestor, request.selection, request.target, prop, request.time)
        x.XSendEvent(display, request.requestor, 0, 0, C.byref(reply))
        x.XFlush(display)
    if not served:
        raise RuntimeError('O aplicativo do guest não aceitou a colagem')
finally:
    x.XCloseDisplay(display)
    if input_display != display:
        x.XCloseDisplay(input_display)
