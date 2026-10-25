import { basename, dirname } from "node:path"
import { guestFileErrors, WorkspacePathError } from "./workspace-path"

export const getImagePattern = (pattern: string): { prefix: string; suffix: string } => {
  const filename = basename(pattern)
  if (
    pattern.length > 4096 ||
    /[?*[\]{}]/.test(dirname(pattern)) ||
    !/^[\w .-]*\*[\w .*-]*\.(png|jpe?g|webp|gif)$/i.test(filename) ||
    filename.split("*").length !== 2
  )
    throw new WorkspacePathError(400)
  const [prefix = "", suffix = ""] = filename.toLowerCase().split("*")

  return { prefix, suffix }
}

// Names, roots and patterns are arguments. Every ancestor and candidate uses no-follow descriptors.
export const guestImageReferences = guestFileErrors(`import os,sys,stat,json,itertools
root,directory,prefix,suffix=sys.argv[1:]
parts=[p for p in directory.split('/') if p]
if any(p in ('.','..') or '\\\\' in p for p in parts): raise Exception('Invalid directory')
fd=os.open(root,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
try:
 for part in parts:
  child=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd)
  os.close(fd)
  fd=child
 names=[]
 with os.scandir(fd) as entries:
  for entry in itertools.islice(entries,512):
   name=entry.name.lower()
   if len(name)<len(prefix)+len(suffix) or not name.startswith(prefix) or not name.endswith(suffix): continue
   try:
    image=os.open(entry.name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=fd)
    with os.fdopen(image,'rb') as file:
     info=os.fstat(file.fileno())
     if not stat.S_ISREG(info.st_mode) or info.st_size>15728640: continue
     header=file.read(12)
     raster=header.startswith(b'\\x89PNG\\r\\n\\x1a\\n') or header.startswith(b'\\xff\\xd8\\xff') or header[:6] in (b'GIF87a',b'GIF89a') or (header[:4]==b'RIFF' and header[8:12]==b'WEBP')
     if raster: names.append(entry.name)
   except OSError: continue
   if len(names)==6: break
 print(json.dumps(dict(names=names)))
finally: os.close(fd)`)
