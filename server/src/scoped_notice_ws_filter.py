"""Executed inside napcat. Only scoped, scrubbed recall notices leave stdout."""
import base64,hashlib,json,os,re,socket,struct,sys,time,threading
BOT='';PRIVATES=set();GROUPS=set();PORT=3000;MAX=32768

def account(v):
 if type(v) is int and 0<v<=9007199254740991:return str(v)
 return v if isinstance(v,str) and re.fullmatch(r'[1-9][0-9]{0,19}',v) else None

def filter_notice(v):
 # Only verified notice kinds. No message body, URLs or API results may leave.
 if not isinstance(v,dict) or v.get('post_type')!='notice' or account(v.get('self_id'))!=BOT:return None
 kind=v.get('notice_type')
 if kind not in ('group_recall','friend_recall','group_msg_emoji_like'):return None
 author=account(v.get('user_id'));msg=v.get('message_id');ts=v.get('time')
 msg=str(msg) if type(msg) is int else msg
 if not author or not isinstance(msg,str) or not re.fullmatch(r'-?[0-9]{1,20}',msg) or msg=='0' or type(ts) is not int or ts<0 or ts>9007199254740991//1000 or ts>time.time()+30:return None
 out={'post_type':'notice','notice_type':kind,'self_id':BOT,'user_id':author,'message_id':msg,'time':ts}
 if kind in ('group_recall','group_msg_emoji_like'):
  if account(v.get('group_id')) not in GROUPS:return None
  out['group_id']=account(v.get('group_id'))
 else:
  if 'group_id' in v or author not in PRIVATES:return None
 if 'operator_id' in v:
  operator=account(v['operator_id'])
  if not operator:return None
  out['operator_id']=operator
 if kind=='group_msg_emoji_like':
  likes=v.get('likes')
  if type(v.get('is_add')) is not bool or not isinstance(likes,list) or not 1<=len(likes)<=5:return None
  cleaned=[]
  for item in likes:
   if not isinstance(item,dict):return None
   emoji=str(item.get('emoji_id')) if type(item.get('emoji_id')) is int else item.get('emoji_id');count=item.get('count')
   if not isinstance(emoji,str) or not re.fullmatch(r'[0-9]{1,10}',emoji) or type(count) is not int or not 0<=count<=1000000:return None
   cleaned.append({'emoji_id':emoji,'count':count})
  out['likes']=cleaned;out['is_add']=v['is_add']
 return out

def exact(s,n):
 data=bytearray()
 while len(data)<n:
  chunk=s.recv(n-len(data))
  if not chunk:raise EOFError()
  data.extend(chunk)
 return bytes(data)
def masked_control(op,data=b''):
 if len(data)>125:raise ValueError('control size')
 mask=os.urandom(4);return bytes([128|op,128|len(data)])+mask+bytes(v^mask[i%4] for i,v in enumerate(data))
def frames(s):
 fragmented=None;discard=False;count=0
 while True:
  a,b=exact(s,2);fin=bool(a&128);op=a&15
  if a&112 or b&128 or op not in [0,1,2,8,9,10]:raise ValueError('protocol')
  size=b&127
  if size==126:size=struct.unpack('!H',exact(s,2))[0]
  elif size==127:size=struct.unpack('!Q',exact(s,8))[0]
  if size>8*1024*1024:raise ValueError('frame budget')
  if op>=8 and (not fin or size>125):raise ValueError('control frame')
  if size>MAX:
   remaining=size
   while remaining:remaining-=len(exact(s,min(remaining,MAX)))
   data=None
  else:data=exact(s,size)
  if op==8:return
  if op==9:s.sendall(masked_control(10,data));continue
  if op==10:continue
  if op in [1,2]:
   if fragmented is not None:raise ValueError('fragment overlap')
   fragmented=bytearray();discard=op==2 or data is None;count=0
  elif fragmented is None:raise ValueError('orphan continuation')
  count+=1
  if count>64:raise ValueError('fragment budget')
  if data is None or len(fragmented)+(len(data) if data else 0)>MAX:discard=True
  if not discard:fragmented.extend(data)
  if fin:
   if not discard:yield bytes(fragmented)
   fragmented=None;discard=False
def emit(value):print(json.dumps(value,separators=(',',':')),flush=True)
def main():
 global BOT,PRIVATES,GROUPS,PORT
 token=sys.stdin.readline(160).strip()
 if not re.fullmatch(r'[A-Za-z0-9_-]{40,100}',token):raise ValueError('credential format')
 cfg=json.loads(sys.stdin.readline(4096));BOT=cfg['self_id'];PRIVATES=set(cfg['privates']);GROUPS=set(cfg['groups']);PORT=cfg['port']
 if not account(BOT) or not all(account(x) for x in PRIVATES|GROUPS) or type(PORT) is not int or not 1<=PORT<=65535:raise ValueError('config')
 key=base64.b64encode(os.urandom(16)).decode();accept=base64.b64encode(hashlib.sha1((key+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').encode()).digest()).decode()
 with socket.create_connection(('127.0.0.1',PORT),timeout=8) as s:
  request='GET / HTTP/1.1\r\nHost: 127.0.0.1:'+str(PORT)+'\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: '+key+'\r\nSec-WebSocket-Version: 13\r\nAuthorization: Bearer '+token+'\r\n\r\n'
  s.sendall(request.encode());headers=bytearray()
  while not headers.endswith(b'\r\n\r\n'):
   if len(headers)>=16384:raise ValueError('header budget')
   headers.extend(exact(s,1))
  lines=headers.decode('ascii').split('\r\n');values={}
  for line in lines[1:]:
   if ':' in line:
    k,v=line.split(':',1);k=k.lower()
    if k in values:raise ValueError('duplicate header')
    values[k]=v.strip()
  if ' 101 ' not in lines[0] or values.get('sec-websocket-accept')!=accept or values.get('upgrade','').lower()!='websocket' or 'upgrade' not in [x.strip().lower() for x in values.get('connection','').split(',')]:raise ValueError('handshake')
  def owner_lifetime():
   try:sys.stdin.read(1)
   finally:
    try:s.shutdown(socket.SHUT_RDWR)
    except OSError:pass
  threading.Thread(target=owner_lifetime,daemon=True).start()
  emit({'kind':'connected'});s.settimeout(120)
  for data in frames(s):
   try:v=filter_notice(json.loads(data.decode('utf8')))
   except (ValueError,RecursionError,TypeError):continue
   if v:emit({'kind':'notice','notice':v})
if __name__=='__main__':
 try:main()
 except Exception:pass
 finally:emit({'kind':'disconnected'})
