// Run before the image's init on EVERY start, even with an older bot image.
// Python expands paths in the guest; no shell interpolation or unresolved globs.
export const BOT_BOOT_COMMAND = `import os, pathlib
for pattern in (".X*-lock", ".X11-unix/X*", "touri-ready", "touri-init-error"):
    for path in pathlib.Path("/tmp").glob(pattern):
        path.unlink(missing_ok=True)
os.execv("/usr/local/lib/touri/init.sh", ["/usr/local/lib/touri/init.sh"])
`

export const VM_PROCESS_COMMAND = `import os,sys,json,secrets
parent=os.open(os.path.dirname(sys.argv[1]),os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
name=os.path.basename(sys.argv[1]);temporary='.'+name+'.'+secrets.token_hex(16)
fd=None
try:
 fd=os.open(temporary,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600,dir_fd=parent)
 started=open('/proc/self/stat').read().rsplit(')',1)[1].split()[19] if os.path.exists('/proc/self/stat') else ''
 data=json.dumps(dict(pid=os.getpid(),started=started)).encode()
 if os.write(fd,data)!=len(data): raise OSError('short process marker')
 os.fsync(fd);os.close(fd);fd=None
 os.link(temporary,name,src_dir_fd=parent,dst_dir_fd=parent,follow_symlinks=False)
 os.fsync(parent)
finally:
 if fd is not None: os.close(fd)
 try: os.unlink(temporary,dir_fd=parent)
 except FileNotFoundError: pass
 os.close(parent)
if os.path.lexists(sys.argv[1]+'.cancel'): sys.exit(130)
os.execvpe(sys.argv[2],sys.argv[2:],os.environ)`

// Publish cancellation before reading the marker: cancellation before launch
// cannot leave a late guest process running. Match uid/start time before kill.
export const CANCEL_VM_PROCESS_COMMAND = `const fs=require('node:fs');
const path=process.argv[1];
try{const fd=fs.openSync(path+'.cancel',fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_WRONLY|fs.constants.O_NOFOLLOW,0o600);fs.closeSync(fd)}catch{}
try{
 const fd=fs.openSync(path,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
 let job,owner;try{const info=fs.fstatSync(fd);if(!info.isFile())process.exit(0);owner=info.uid;job=JSON.parse(fs.readFileSync(fd,'utf8'))}finally{fs.closeSync(fd)}
 if(!Number.isSafeInteger(job.pid)||job.pid<2)process.exit(0);
 const raw=fs.readFileSync('/proc/'+job.pid+'/stat','utf8');const stat=raw.slice(raw.lastIndexOf(')')+1).trim().split(/\\s+/);
 const uid=Number(fs.readFileSync('/proc/'+job.pid+'/status','utf8').match(/^Uid:\\s+(\\d+)/m)?.[1]);
 const requested=(process.argv[3]||'0').split(':')[0];const expected=/^\\d+$/.test(requested)?Number(requested):Number(fs.readFileSync('/etc/passwd','utf8').split('\\n').find(line=>line.startsWith(requested+':'))?.split(':')[2]);
 if(String(stat[19])===job.started&&Number(stat[2])===job.pid&&uid===expected&&owner===expected)process.kill(-job.pid,process.argv[2]);
}catch{}`
