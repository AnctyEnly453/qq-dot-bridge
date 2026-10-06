import {CONFIG,sourcePath,localPath} from './config.mjs';
import fs from 'node:fs';
import {spawn} from 'node:child_process';
export function startScopedNoticeSource(ingress,{spawnImpl=spawn,readFile=fs.readFileSync,schedule=setTimeout,cancel=clearTimeout}={}) {
 const code=readFile(sourcePath('scoped_notice_ws_filter.py'),'utf8');let stopped=false,child=null,timer=null;
 const reconnect=()=>{if(!stopped)timer=schedule(connect,30000);};
 const connect=()=>{
  if(stopped)return;timer=null;let buffer='';
  const script=`import base64;exec(base64.b64decode('${Buffer.from(code).toString('base64')}'),{'__name__':'__main__'})`;
  try{child=spawnImpl('docker',['exec','-i',CONFIG.napcat.container,'python3','-I','-u','-c',script],{stdio:['pipe','pipe','ignore'],windowsHide:true});
   child.stdin.on('error',()=>{});child.stdin.write(readFile(localPath(CONFIG.napcat.token_file),'utf8').trim()+'\n'+JSON.stringify({self_id:CONFIG.self_id,privates:CONFIG.allowed_privates,groups:CONFIG.allowed_groups,port:CONFIG.napcat.http_port})+'\n');
  }catch{child?.kill();ingress.disconnected();reconnect();return;}
  let finished=false;
  const end=()=>{if(finished)return;finished=true;if(stopped)return;ingress.disconnected();reconnect();};
  child.on('error',end);child.on('close',end);
  child.stdout.on('data',chunk=>{
   if(stopped||finished)return;buffer+=chunk.toString('utf8');
   if(buffer.length>32768){child.kill();end();return;}
   let split;while((split=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,split);buffer=buffer.slice(split+1);try{
    const value=JSON.parse(line);
    if(value.kind==='connected'&&Object.keys(value).length===1)ingress.connected();
    else if(value.kind==='disconnected'&&Object.keys(value).length===1)ingress.disconnected();
    else if(value.kind==='notice'&&Object.keys(value).sort().join(',')==='kind,notice')ingress.acceptNotice(value.notice);
    else{child.kill();end();return;}
   }catch{child.kill();end();return;}}
  });
 };
 connect();return {stop(){if(stopped)return;stopped=true;if(timer!==null)cancel(timer);if(child){child.stdin.destroy?.();child.kill();}ingress.disconnected();}};
}
