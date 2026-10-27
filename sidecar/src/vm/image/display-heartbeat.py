"""A small X11 pulse makes even a motionless desktop's complete render path observable."""
import ctypes as c
import os
import time

x = c.CDLL("libX11.so.6")
x.XOpenDisplay.argtypes = [c.c_char_p]
x.XOpenDisplay.restype = c.c_void_p
display = x.XOpenDisplay(os.environ.get("DISPLAY", ":99").encode())
if not display:
    raise RuntimeError("Display indisponível")

# Explicit signatures keep XIDs and pointers intact on 64-bit guests.
def bind(name, args, result=c.c_int):
    function = getattr(x, name)
    function.argtypes = [c.c_void_p, *args]
    function.restype = result
    return function

root = bind("XDefaultRootWindow", [], c.c_ulong)(display)
screen = bind("XDefaultScreen", [])(display)
width = bind("XDisplayWidth", [c.c_int])(display, screen)
height = bind("XDisplayHeight", [c.c_int])(display, screen)
window = bind("XCreateSimpleWindow", [c.c_ulong, c.c_int, c.c_int, c.c_uint, c.c_uint, c.c_uint, c.c_ulong, c.c_ulong], c.c_ulong)(
    display, root, width - 8, height - 8, 8, 8, 0, 0, 0
)
# A window manager must not decorate, move or focus the liveness marker.
class WindowAttributes(c.Structure):
    _fields_ = [('background_pixmap', c.c_ulong), ('background_pixel', c.c_ulong),
                ('border_pixmap', c.c_ulong), ('border_pixel', c.c_ulong),
                ('bit_gravity', c.c_int), ('win_gravity', c.c_int), ('backing_store', c.c_int),
                ('backing_planes', c.c_ulong), ('backing_pixel', c.c_ulong),
                ('save_under', c.c_int), ('event_mask', c.c_long),
                ('do_not_propagate_mask', c.c_long), ('override_redirect', c.c_int),
                ('colormap', c.c_ulong), ('cursor', c.c_ulong)]

attributes = WindowAttributes(override_redirect=1)
bind("XChangeWindowAttributes", [c.c_ulong, c.c_ulong, c.POINTER(WindowAttributes)])(display, window, 1 << 9, c.byref(attributes))
bind("XStoreName", [c.c_ulong, c.c_char_p])(display, window, b"touri display pulse")
bind("XMapRaised", [c.c_ulong])(display, window)
background = bind("XSetWindowBackground", [c.c_ulong, c.c_ulong])
clear = bind("XClearWindow", [c.c_ulong])
raise_window = bind("XRaiseWindow", [c.c_ulong])
flush = bind("XFlush", [])
# Publish a real root pixmap so the panel can blend its rounded surface without
# a compositor. It stays alive on this display connection, with no redraw loop.
depth = bind("XDefaultDepth", [c.c_int])(display, screen)
pixmap = bind("XCreatePixmap", [c.c_ulong, c.c_uint, c.c_uint, c.c_uint], c.c_ulong)(display, root, width, height, depth)
gc = bind("XCreateGC", [c.c_ulong, c.c_ulong, c.c_void_p], c.c_void_p)(display, pixmap, 0, None)
bind("XSetForeground", [c.c_void_p, c.c_ulong])(display, gc, 0xdce6f2)
bind("XFillRectangle", [c.c_ulong, c.c_void_p, c.c_int, c.c_int, c.c_uint, c.c_uint])(display, pixmap, gc, 0, 0, width, height)
bind("XFreeGC", [c.c_void_p])(display, gc)
bind("XSetWindowBackgroundPixmap", [c.c_ulong, c.c_ulong])(display, root, pixmap)
atom = bind("XInternAtom", [c.c_char_p, c.c_int], c.c_ulong)(display, b"_XROOTPMAP_ID", 0)
pixmap_id = c.c_ulong(pixmap)
# Core atom 20 is PIXMAP; property format 32 uses native unsigned-long storage.
bind("XChangeProperty", [c.c_ulong, c.c_ulong, c.c_ulong, c.c_int, c.c_int, c.c_void_p, c.c_int])(
    display, root, atom, 20, 32, 0, c.byref(pixmap_id), 1
)
clear(display, root)
sequence = 0
while True:
    # Incrementing rather than alternating avoids aliasing with the viewer's sampling interval.
    sequence = (sequence + 1) % 256
    background(display, window, (sequence << 16) | 0x3040)
    clear(display, window)
    raise_window(display, window)
    flush(display)
    time.sleep(1)
