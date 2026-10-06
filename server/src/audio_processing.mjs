import {CONFIG} from './config.mjs';
import fs from 'node:fs';import crypto from 'node:crypto';import {spawn} from 'node:child_process';import {fileURLToPath} from 'node:url';import {fail} from './tool_contract.mjs';
export const AUDIO_LIMITS=Object.freeze({bytes:2*1024*1024,minMs:200,maxMs:60000,normalizedBytes:2880044,mimes:Object.freeze(['audio/wav','audio/mpeg','audio/ogg','audio/flac','audio/mp4'])});
export function createAudioProcessor({spawnImpl=spawn,mode='container',python='python3',script=fileURLToPath(new URL('./audio_codec.py',import.meta.url))}={}){
 let active=0;const code=mode==='container'?fs.readFileSync(script,'utf8'):null;
 return async(bytes,mime)=>{
  if(!Buffer.isBuffer(bytes)||!bytes.length||!AUDIO_LIMITS.mimes.includes(mime))fail(400,'invalid_audio');if(bytes.length>AUDIO_LIMITS.bytes)fail(413,'audio_too_large');if(active>=2)fail(503,'audio_busy');active++;
  try{
   const command=mode==='container'?'docker':python,args=mode==='container'?['exec','-i',CONFIG.napcat.container,'python3','-I','-c',code,mime]:['-I',script,mime];
   const packed=await new Promise((resolve,reject)=>{const child=spawnImpl(command,args,{stdio:['pipe','pipe','ignore'],windowsHide:true}),chunks=[];let size=0,ended=false;
    const stop=e=>{if(ended)return;ended=true;clearTimeout(timer);child.kill();reject(e);};const timer=setTimeout(()=>stop(Object.assign(Error(),{code:'audio_processing_timeout'})),28000);
    child.on('error',()=>stop(Object.assign(Error(),{code:'audio_unavailable'})));child.stdin.on('error',()=>{});child.stdout.on('data',b=>{size+=b.length;if(size>AUDIO_LIMITS.normalizedBytes+4096)stop(Object.assign(Error(),{code:'audio_too_long'}));else chunks.push(b);});
    child.on('close',exit=>{if(ended)return;ended=true;clearTimeout(timer);if(exit!==0)reject(Object.assign(Error(),{code:'audio_unavailable'}));else resolve(Buffer.concat(chunks));});child.stdin.end(bytes);
   }).catch(e=>{fail(e.code==='audio_too_long'?413:503,e.code??'audio_unavailable');});
   if(packed.length<4)fail(503,'audio_unavailable');const n=packed.readUInt32BE(0);if(n<2||n>4096||packed.length<n+4)fail(503,'audio_unavailable');let meta;try{meta=JSON.parse(packed.subarray(4,4+n));}catch{fail(503,'audio_unavailable');}
   if(meta.ok===false){const code=meta.error;if(!['invalid_audio','audio_too_large','audio_type_mismatch','invalid_audio_streams','unsupported_audio_parameters','audio_too_long','audio_too_short','audio_unavailable','audio_processing_timeout'].includes(code))fail(503,'audio_unavailable');fail(['audio_unavailable','audio_processing_timeout'].includes(code)?503:['audio_too_large','audio_too_long'].includes(code)?413:400,code);}
   const normalized=packed.subarray(4+n),sha=crypto.createHash('sha256').update(normalized).digest('hex');
   if(meta.ok!==true||meta.input_mime!==mime||meta.input_bytes!==bytes.length||meta.output_bytes!==normalized.length||meta.output_sha256!==sha||meta.output_mime!=='audio/wav'||meta.output_sample_rate!==24000||meta.output_channels!==1||!Number.isInteger(meta.duration_ms)||meta.duration_ms<AUDIO_LIMITS.minMs||meta.duration_ms>AUDIO_LIMITS.maxMs||normalized.length>AUDIO_LIMITS.normalizedBytes||normalized.toString('ascii',0,4)!=='RIFF'||normalized.toString('ascii',8,12)!=='WAVE')fail(503,'invalid_audio_decoder_response');
   return {bytes:Buffer.from(normalized),metadata:meta};
  }finally{active--;}
 };
}
