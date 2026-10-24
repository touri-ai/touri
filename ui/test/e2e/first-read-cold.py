import ctypes
import json
import mmap
import os
import sys
from pathlib import Path


def main():
    path = Path(sys.argv[1]).resolve()
    assert path.name == 'touri.db'
    assert path.parent.name.startswith('touri-server-mode-')
    libc = ctypes.CDLL(None, use_errno=True)
    libc.mincore.argtypes = [ctypes.c_void_p, ctypes.c_size_t, ctypes.c_void_p]
    fd = os.open(path, os.O_RDONLY)
    try:
        os.fsync(fd)
        os.posix_fadvise(fd, 0, 0, os.POSIX_FADV_DONTNEED)
        size = os.fstat(fd).st_size
        mapping = mmap.mmap(fd, size, access=mmap.ACCESS_COPY)
        view = ctypes.c_char.from_buffer(mapping)
        pages = (size + mmap.PAGESIZE - 1) // mmap.PAGESIZE
        vector = (ctypes.c_ubyte * pages)()
        if libc.mincore(ctypes.addressof(view), size, vector):
            raise OSError(ctypes.get_errno(), 'mincore')
        resident = sum(value & 1 for value in vector)
        del view
        mapping.close()
        print(json.dumps({'pages': pages, 'resident': resident, 'bytes': size}))
    finally:
        os.close(fd)


if __name__ == '__main__':
    main()
