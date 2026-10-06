// Pure message validation: no filesystem, network, credentials or target policy.
export const MEDIA_LIMITS = Object.freeze({messages:8,textCodePoints:2000,images:1,imageBytes:2*1024*1024,faceMin:0,faceMax:500});
export const IMAGE_MIMES = Object.freeze(['image/png','image/jpeg','image/gif','image/webp']);
const MAX_BASE64 = 4 * Math.ceil(MEDIA_LIMITS.imageBytes / 3);
export class MediaFailure extends Error {
  constructor(status,code){super(code);this.name='MediaFailure';this.status=status;this.code=code;}
}
const defaultError = (status,code)=>new MediaFailure(status,code);
const exactKeys = (value,names)=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join(',')===[...names].sort().join(',');

// Header/container preflight only. Full decoding is mandatory below.
function matchesContainer(bytes,mime){
  if(mime==='image/png')return bytes.length>=8&&bytes.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex'));
  if(mime==='image/jpeg')return bytes.length>=4&&bytes[0]===255&&bytes[1]===216&&bytes[bytes.length-2]===255&&bytes[bytes.length-1]===217;
  if(mime==='image/gif')return bytes.length>=14&&['GIF87a','GIF89a'].includes(bytes.toString('ascii',0,6))&&bytes[bytes.length-1]===59;
  if(mime==='image/webp')return bytes.length>=20&&bytes.toString('ascii',0,4)==='RIFF'&&bytes.readUInt32LE(4)===bytes.length-8&&bytes.toString('ascii',8,12)==='WEBP'&&['VP8 ','VP8L','VP8X'].includes(bytes.toString('ascii',12,16));
  return false;
}

/** Same (Buffer,mime) interface as the existing bridge's imageValidator hook.
 * decodeImage must reject corrupt/truncated data and enforce dimensions, pixels,
 * frame count and every-frame decoding. Successful return values are ignored.
 */
export async function validateImageBytes(bytes,mime,{decodeImage,errorFactory=defaultError}={}){
  const fail=(status,code)=>{throw errorFactory(status,code);};
  if(!Buffer.isBuffer(bytes)||!bytes.length||!IMAGE_MIMES.includes(mime))fail(400,'invalid_image');
  if(bytes.length>MEDIA_LIMITS.imageBytes)fail(413,'message_too_large');
  if(!matchesContainer(bytes,mime))fail(400,'invalid_image');
  if(typeof decodeImage!=='function')fail(503,'media_unavailable');
  try{await decodeImage(bytes,mime);}catch(error){
    // Preserve only the public decoder contract, never diagnostics.
    if(error?.status===400&&error?.code==='invalid_image')fail(400,'invalid_image');
    if(error?.status===413&&error?.code==='message_too_large')fail(413,'message_too_large');
    fail(503,'media_unavailable');
  }
}

/** Returns the original bridge's flattened message schema, freshly copied.
 * No input target/request_id fields: the caller authenticates and authorizes them.
 */
export async function validateMessages(messages,{decodeImage,errorFactory=defaultError}={}){
  const fail=(status,code)=>{throw errorFactory(status,code);};
  if(!Array.isArray(messages)||messages.length<1||messages.length>MEDIA_LIMITS.messages)fail(400,'invalid_request');
  const result=[];let textCount=0,imageCount=0;
  for(const item of messages){
    if(item?.type==='text'){
      if(!exactKeys(item,['type','text'])||typeof item.text!=='string'||!item.text.length||item.text.includes('\0'))fail(400,'invalid_request');
      textCount += [...item.text].length;
      if(textCount>MEDIA_LIMITS.textCodePoints)fail(413,'message_too_large');
      result.push({type:'text',text:item.text});
    }else if(item?.type==='face'){
      if(!exactKeys(item,['type','id'])||!Number.isInteger(item.id)||item.id<MEDIA_LIMITS.faceMin||item.id>MEDIA_LIMITS.faceMax)fail(400,'invalid_request');
      result.push({type:'face',id:item.id});
    }else if(item?.type==='image'){
      if(!exactKeys(item,['type','mime','data_base64']))fail(400,'invalid_request');
      if(++imageCount>MEDIA_LIMITS.images)fail(413,'message_too_large');
      // Snapshot the validated fields before yielding to the trusted decoder.
      const {mime,data_base64}=item;
      if(!IMAGE_MIMES.includes(mime)||typeof data_base64!=='string')fail(400,'invalid_image');
      if(data_base64.length>MAX_BASE64)fail(413,'message_too_large');
      if(!data_base64.length||data_base64.length%4!==0||!/^[A-Za-z0-9+/]+={0,2}$/.test(data_base64))fail(400,'invalid_image');
      const bytes=Buffer.from(data_base64,'base64');
      if(bytes.toString('base64')!==data_base64)fail(400,'invalid_image');
      await validateImageBytes(bytes,mime,{decodeImage,errorFactory});
      result.push({type:'image',mime,data_base64});
    }else fail(400,'invalid_request');
  }
  return result;
}

/** Validates first, then emits OneBot segments for NapCat's message array. */
export async function normalizeMessages(messages,options){
  return (await validateMessages(messages,options)).map(item=>{
    if(item.type==='text')return {type:'text',data:{text:item.text}};
    if(item.type==='face')return {type:'face',data:{id:String(item.id)}};
    return {type:'image',data:{file:'base64://'+item.data_base64}};
  });
}
