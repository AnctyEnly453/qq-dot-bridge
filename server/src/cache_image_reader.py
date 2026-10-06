"""Read the fixed QQ cache bind mount; public input can never choose host paths."""
import json,os,re,stat,sys
LIMIT=2*1024*1024
HOST_QQ_ROOT=sys.argv[1] if len(sys.argv)>1 else ''
CONTAINER_QQ_ROOT=sys.argv[2] if len(sys.argv)>2 else ''
class ReaderFailure(Exception):
    def __init__(self,code):self.code=code
def read_image(data):
    if not isinstance(data,dict) or set(data)!={'path','file_id'}:raise ReaderFailure(2)
    path=data['path'];file_id=data['file_id']
    if not isinstance(path,str) or not isinstance(file_id,str) or len(path)>2048 or len(file_id)>128:raise ReaderFailure(2)
    if not re.fullmatch(r'[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?',file_id):raise ReaderFailure(2)
    if not HOST_QQ_ROOT.startswith('/') or not CONTAINER_QQ_ROOT.startswith('/'):raise ReaderFailure(2)
    allowed=bool(re.match('^'+re.escape(CONTAINER_QQ_ROOT)+r'/nt_qq_[A-Za-z0-9_-]+/nt_data/Pic/',path)) or path.startswith(CONTAINER_QQ_ROOT+'/NapCat/temp/')
    parts=path.split('/')
    if not allowed or any(part in ('.','..','') for part in parts[1:]) or '\x00' in path or '\\' in path or parts[-1].lower()!=file_id.lower():raise ReaderFailure(2)
    relative=path[len(CONTAINER_QQ_ROOT)+1:].split('/')
    # Open each directory component without following symlinks, including the fixed root.
    host_parts=HOST_QQ_ROOT.strip('/').split('/')+relative
    fd=os.open('/',os.O_RDONLY|os.O_DIRECTORY)
    try:
        for part in host_parts[:-1]:
            nxt=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd);os.close(fd);fd=nxt
        image_fd=os.open(host_parts[-1],os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=fd)
    finally:os.close(fd)
    with os.fdopen(image_fd,'rb') as stream:
        info=os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_size<1:raise ReaderFailure(2)
        if info.st_size>LIMIT:raise ReaderFailure(3)
        image=stream.read(LIMIT+1)
        if len(image)>LIMIT:raise ReaderFailure(3)
    return image
if __name__=='__main__':
    try:sys.stdout.buffer.write(read_image(json.loads(sys.stdin.buffer.read(4097))))
    except ReaderFailure as error:sys.exit(error.code)
    except Exception:sys.exit(4)
