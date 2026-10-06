import {Failure,TARGET,keys} from './chat_bridge.mjs';
import {validateImageBytes} from './media_messages.mjs';
import {snapshot,ToolFailure} from './tool_contract.mjs';

export const MEDIA_PATH='/qq/private/media';
export const validFileId=value=>typeof value==='string'&&value.length<=128&&/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?$/.test(value);
export function validateMediaRequest(value){
  try { value=snapshot(value); } catch(error) { if(error instanceof ToolFailure)throw new Failure(error.status,error.code);throw error; }
  keys(value,['target','cursor','file_id']);
  if(value.target!==TARGET)throw new Failure(403,'target_forbidden');
  if(typeof value.cursor!=='string'||!/^(0|[1-9][0-9]{0,15})$/.test(value.cursor)||!Number.isSafeInteger(Number(value.cursor)))throw new Failure(400,'invalid_cursor');
  if(!validFileId(value.file_id))throw new Failure(400,'invalid_media_reference');
  return value;
}
export function imageMime(bytes){
  if(!Buffer.isBuffer(bytes))throw new Failure(400,'invalid_image');
  if(bytes.length>=8&&bytes.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex')))return 'image/png';
  if(bytes.length>=3&&bytes[0]===255&&bytes[1]===216&&bytes[2]===255)return 'image/jpeg';
  if(bytes.length>=6&&['GIF87a','GIF89a'].includes(bytes.toString('ascii',0,6)))return 'image/gif';
  if(bytes.length>=12&&bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP')return 'image/webp';
  throw new Failure(400,'invalid_image');
}
export class PrivateMedia {
  constructor(queue,adapter,decodeImage){this.queue=queue;this.adapter=adapter;this.decodeImage=decodeImage;}
  async read(input){
    const value=validateMediaRequest(input);
    const row=this.queue.db.prepare('SELECT payload FROM received WHERE seq=? AND expires>?').get(Number(value.cursor),this.queue.now());
    if(!row)throw new Failure(404,'media_not_found');
    const message=JSON.parse(row.payload);
    if(message.conversation?.type!=='private'||message.conversation.id!==TARGET||message.user_id!==TARGET||!message.messages.some(item=>item.type==='image'&&item.file_id===value.file_id))throw new Failure(404,'media_not_found');
    const recheck=()=>{
      const current=this.queue.db.prepare('SELECT payload FROM received WHERE seq=? AND expires>?').get(Number(value.cursor),this.queue.now());
      if(!current||current.payload!==row.payload)throw new Failure(404,'media_not_found');
    };
    if(typeof this.adapter?.readImage!=='function'||typeof this.decodeImage!=='function')throw new Failure(503,'media_unavailable');
    let received;
    try { received=await this.adapter.readImage(value.file_id); }
    catch { recheck();throw new Failure(503,'media_unavailable'); }
    recheck();
    const bytes=Buffer.isBuffer(received)?Buffer.from(received):received;
    if(!Buffer.isBuffer(bytes)||!bytes.length)throw new Failure(400,'invalid_image');
    if(bytes.length>2*1024*1024)throw new Failure(413,'message_too_large');
    const mime=imageMime(bytes);
    const decodingBytes=Buffer.from(bytes);
    try { await validateImageBytes(decodingBytes,mime,{decodeImage:this.decodeImage,errorFactory:(status,code)=>new Failure(status,code)}); }
    catch(error) { recheck();throw error; }
    recheck();
    if(!decodingBytes.equals(bytes))throw new Failure(400,'invalid_image');
    return {cursor:value.cursor,message_id:message.message_id,file_id:value.file_id,mime,data_base64:bytes.toString('base64')};
  }
}
