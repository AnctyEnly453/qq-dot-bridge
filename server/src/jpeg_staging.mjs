import {CONFIG} from './config.mjs';
import {spawn} from 'node:child_process';import crypto from 'node:crypto';
const code=String.raw`import sys,json,base64,hashlib,os,stat,re
p=json.loads(sys.stdin.buffer.read(2900000));b=base64.b64decode(p['data_base64'],validate=True)
if not 4<=len(b)<=2097152 or b[:3]!=bytes.fromhex('ffd8ff') or b[-2:]!=bytes.fromhex('ffd9') or hashlib.sha256(b).hexdigest()!=p['sha256'] or not re.fullmatch(r'[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}',p['id']):raise ValueError('invalid JPEG stage')
root='/tmp/dot-jpeg-send';owners=set()
for pid in os.listdir('/proc'):
 if not pid.isdigit():continue
 try:
  if open('/proc/'+pid+'/comm').read().strip().lower()=='qq':
   q=os.stat('/proc/'+pid);owners.add((q.st_uid,q.st_gid))
 except OSError:pass
if len(owners)>1:raise ValueError('ambiguous owner')
owner=next(iter(owners),(os.geteuid(),os.getegid()))
try:os.mkdir(root,0o700)
except FileExistsError:pass
if not stat.S_ISDIR(os.lstat(root).st_mode):raise ValueError('invalid JPEG stage directory')
if os.geteuid()==0:os.chown(root,*owner)
os.chmod(root,0o700)
if len(os.listdir(root))>=8:print(json.dumps({'error':'jpeg_stage_full'}));sys.exit(2)
path=root+'/'+p['id']+'-'+p['sha256']+'.jpg';fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
if os.geteuid()==0:os.fchown(fd,*owner)
with os.fdopen(fd,'wb') as f:f.write(b)
print(json.dumps({'path':path,'sha256':hashlib.sha256(open(path,'rb').read()).hexdigest(),'bytes':len(b)}))
`;
const remove=String.raw`import sys,json,re,os
path=json.loads(sys.stdin.buffer.read(4096))
if not re.fullmatch(r'/tmp/dot-jpeg-send/[a-f0-9-]{36}-[a-f0-9]{64}\.jpg',path):raise ValueError('invalid JPEG stage')
d=os.open('/tmp/dot-jpeg-send',os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
try:os.unlink(path.rsplit('/',1)[1],dir_fd=d)
finally:os.close(d)
`;
function run(script,input){return new Promise((resolve,reject)=>{const child=spawn('docker',['exec','-i',CONFIG.napcat.container,'python3','-I','-c',script],{stdio:['pipe','pipe','ignore'],windowsHide:true});let output='',done=false;
 const finish=(error,value)=>{if(done)return;done=true;clearTimeout(timer);error?reject(error):resolve(value);},timer=setTimeout(()=>{child.kill();finish(Object.assign(Error(),{code:'jpeg_stage_unavailable'}));},12000);
 child.stdin.on('error',()=>{});child.on('error',()=>finish(Object.assign(Error(),{code:'jpeg_stage_unavailable'})));child.stdout.on('data',b=>{output+=b;if(output.length>4096){child.kill();finish(Object.assign(Error(),{code:'jpeg_stage_unavailable'}));}});
 child.on('close',exit=>{if(exit===0)return finish(null,output.trim());finish(Object.assign(Error(),{code:output.includes('jpeg_stage_full')?'jpeg_stage_full':'jpeg_stage_unavailable'}));});child.stdin.end(JSON.stringify(input));});}
export function createJpegStager(){return Object.freeze({
 async stage(bytes){if(!Buffer.isBuffer(bytes)||bytes.length<4||bytes.length>2*1024*1024||bytes.subarray(0,3).toString('hex')!=='ffd8ff'||bytes.subarray(-2).toString('hex')!=='ffd9')throw Object.assign(Error(),{code:'jpeg_stage_unavailable'});const id=crypto.randomUUID(),sha256=crypto.createHash('sha256').update(bytes).digest('hex'),answer=JSON.parse(await run(code,{id,sha256,data_base64:bytes.toString('base64')})),expected='/tmp/dot-jpeg-send/'+id+'-'+sha256+'.jpg';if(answer.path!==expected||answer.sha256!==sha256||answer.bytes!==bytes.length)throw Object.assign(Error(),{code:'jpeg_stage_unavailable'});return expected;},
 async remove(path){await run(remove,path);}
});}
