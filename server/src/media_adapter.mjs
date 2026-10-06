import {CONFIG,sourcePath} from './config.mjs';
import {execFile} from 'node:child_process';

const FORMATS = Object.freeze({'image/png':'PNG','image/jpeg':'JPEG','image/gif':'GIF','image/webp':'WEBP'});
const MAX_BYTES = 2 * 1024 * 1024;
const defaultError = (status,code)=>Object.assign(new Error(code),{status,code});

// Paths are deployment configuration, never properties of an incoming message.
export function createImageValidator({python=CONFIG.python,script=sourcePath('media_validator.py'),errorFactory=defaultError,runner=execFile}={}) {
  return async (bytes,mime)=>{
    const fail=(status,code)=>{throw errorFactory(status,code);};
    if(!Buffer.isBuffer(bytes)||!bytes.length||!Object.hasOwn(FORMATS,mime))fail(400,'invalid_image');
    if(bytes.length>MAX_BYTES)fail(413,'message_too_large');
    let output;
    try {
      output=await new Promise((resolve,reject)=>{
        const child=runner(python,['-I',script,mime],{timeout:12000,maxBuffer:2048,windowsHide:true},(error,stdout)=>error?reject(new Error('decoder unavailable')):resolve(stdout));
        child.stdin.on('error',()=>{});
        child.stdin.end(bytes);
      });
    } catch { fail(503,'media_unavailable'); }
    let result;
    try {result=JSON.parse(output);}catch{fail(503,'media_unavailable');}
    if(result?.ok===false){
      if(result.error==='message_too_large')fail(413,'message_too_large');
      if(result.error==='invalid_image')fail(400,'invalid_image');
      fail(503,'media_unavailable');
    }
    if(result?.ok!==true||result.format!==FORMATS[mime]||!Number.isInteger(result.width)||!Number.isInteger(result.height)||!Number.isInteger(result.frames)||result.width<1||result.height<1||Math.max(result.width,result.height)>4096||result.width*result.height>12000000||result.frames<1||result.frames>60)fail(400,'invalid_image');
    return {format:result.format,width:result.width,height:result.height,frames:result.frames};
  };
}
