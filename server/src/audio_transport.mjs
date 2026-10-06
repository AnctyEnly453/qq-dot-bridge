import {CONFIG} from './config.mjs';
import {spawn} from 'node:child_process';import {requireConversation} from './scoped_policy.mjs';import {fail} from './tool_contract.mjs';
const stageCode=String.raw`import sys,json,base64,hashlib,os,stat,re,time
p=json.loads(sys.stdin.buffer.read(4100000));b=base64.b64decode(p['data_base64'],validate=True)
if not 44<len(b)<=2880044 or hashlib.sha256(b).hexdigest()!=p['sha256'] or not re.fullmatch(r'[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}',p['request_id']):raise ValueError('stage invalid')
root='/tmp/dot-audio-send';owners=set()
for pid in os.listdir('/proc'):
 if not pid.isdigit():continue
 try:
  if open('/proc/'+pid+'/comm').read().strip().lower()=='qq':
   s=os.stat('/proc/'+pid);owners.add((s.st_uid,s.st_gid))
 except OSError:pass
if len(owners)>1:raise ValueError('ambiguous owner')
owner=next(iter(owners),(os.geteuid(),os.getegid()))
try:os.mkdir(root,0o700)
except FileExistsError:pass
if not stat.S_ISDIR(os.lstat(root).st_mode):raise ValueError('stage directory invalid')
if os.geteuid()==0:os.chown(root,*owner)
os.chmod(root,0o700);names=[n for n in os.listdir(root) if re.fullmatch(r'[a-f0-9-]{36}-[a-f0-9]{64}.wav',n)]
if len(names)>=8:raise ValueError('audio stage full')
path=root+'/'+p['request_id']+'-'+p['sha256']+'.wav';fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
if os.geteuid()==0:os.fchown(fd,*owner)
with os.fdopen(fd,'wb') as f:f.write(b)
print(path)
`;
const removeCode=String.raw`import sys,json,re,os
p=json.loads(sys.stdin.buffer.read(4096))
if not re.fullmatch(r'/tmp/dot-audio-send/[a-f0-9-]{36}-[a-f0-9]{64}.wav',p):raise ValueError('invalid stage')
d=os.open('/tmp/dot-audio-send',os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
try:os.unlink(p.rsplit('/',1)[1],dir_fd=d)
finally:os.close(d)
`;
function run(code,input){return new Promise((resolve,reject)=>{const child=spawn('docker',['exec','-i',CONFIG.napcat.container,'python3','-I','-c',code],{stdio:['pipe','pipe','ignore'],windowsHide:true});let output='';const timer=setTimeout(()=>{child.kill();reject(Error('audio stage unavailable'));},12000);child.stdin.on('error',()=>{});child.stdout.on('data',b=>{output+=b;if(output.length>4096)child.kill();});child.on('error',reject);child.on('close',exit=>{clearTimeout(timer);exit===0?resolve(output.trim()):reject(Error('audio stage unavailable'));});child.stdin.end(JSON.stringify(input));});}
export function createAudioTransport({policy,adapter}={}){
 return Object.freeze({stage:({request_id,bytes,sha256})=>run(stageCode,{request_id,data_base64:bytes.toString('base64'),sha256}),removeStaged:path=>run(removeCode,path),
  async sendAudio({conversation,path}){const chat=requireConversation(policy,conversation,'send');if(typeof path!=='string'||!/^\/tmp\/dot-audio-send\/[a-f0-9-]{36}-[a-f0-9]{64}\.wav$/.test(path))fail(403,'audio_path_forbidden');
   const payload={...(chat.type==='group'?{group_id:chat.id}:{user_id:Number(chat.id)}),message:[{type:'record',data:{file:path}}],auto_escape:true};return adapter._transport(chat.type==='group'?'send_group_msg':'send_private_msg',payload,16384,{timeoutMs:45000});
  }});
}
