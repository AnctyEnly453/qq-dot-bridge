import {CONFIG,sourcePath} from '../src/config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createImageValidator} from '../src/media_adapter.mjs';
import {Failure,validateSend,TARGET} from '../src/chat_bridge.mjs';
const good={ok:true,format:'PNG',width:1,height:1,frames:1};
const factory=(status,code)=>new Failure(status,code);
const rejection=(status,code)=>error=>error instanceof Failure&&error.status===status&&error.code===code;
function stub(result,error=null,inspect=()=>{}){
  return (file,args,options,callback)=>{
    const stdin=new EventEmitter();stdin.end=bytes=>{inspect(file,args,options,bytes);queueMicrotask(()=>callback(error,typeof result==='string'?result:JSON.stringify(result)));};
    return {stdin};
  };
}
test('decoder only receives bytes on stdin and fixed paths',async()=>{
  const bytes=Buffer.from('inline bytes');
  const validator=createImageValidator({errorFactory:factory,runner:stub(good,null,(file,args,options,input)=>{
    assert.equal(file,CONFIG.python);assert.deepEqual(args,['-I',sourcePath('media_validator.py'),'image/png']);assert.strictEqual(input,bytes);assert.equal(options.maxBuffer,2048);assert.equal(options.timeout,12000);
  })});
  assert.deepEqual(await validator(bytes,'image/png'),{format:'PNG',width:1,height:1,frames:1});
});
test('mime, oversize and nonbyte paths rejected before decoder',async()=>{
  let calls=0;const validator=createImageValidator({errorFactory:factory,runner:()=>{calls++;}});
  await assert.rejects(validator(Buffer.from('x'),'file:///etc/passwd'),rejection(400,'invalid_image'));
  await assert.rejects(validator('http://169.254.169.254/','image/png'),rejection(400,'invalid_image'));
  await assert.rejects(validator(Buffer.alloc(2097153),'image/png'),rejection(413,'message_too_large'));
  assert.equal(calls,0);
});
test('decoded wrong format/dimensions/pixels/frames cannot pass',async()=>{
  for(const fields of [{format:'JPEG'},{width:4097},{width:4096,height:4096},{frames:61},{width:0},{width:'1'}]){
    const validator=createImageValidator({errorFactory:factory,runner:stub({...good,...fields})});
    await assert.rejects(validator(Buffer.from('x'),'image/png'),rejection(400,'invalid_image'));
  }
});
test('decoder rejection/failure and malformed output fail closed',async()=>{
  for(const [result,error,status,code] of [
    [{ok:false,error:'invalid_image'},null,400,'invalid_image'],
    [{ok:false,error:'message_too_large'},null,413,'message_too_large'],
    [{ok:false,error:'media_unavailable'},null,503,'media_unavailable'],
    ['not json',null,503,'media_unavailable'],
    [good,new Error('secret decoder diagnostic'),503,'media_unavailable']
  ])await assert.rejects(createImageValidator({errorFactory:factory,runner:stub(result,error)})(Buffer.from('x'),'image/png'),rejection(status,code));
});
test('existing send schema accepts inline image only after decoder validation',async()=>{
  const payload={target:TARGET,request_id:'285a76f7-6306-45d9-be6d-a29f409901a9',messages:[{type:'image',mime:'image/png',data_base64:Buffer.from('stub bytes').toString('base64')}]};
  const validator=createImageValidator({errorFactory:factory,runner:stub(good)});
  assert.equal((await validateSend(payload,validator)).messages[0].type,'image');
  await assert.rejects(validateSend({...payload,messages:[{type:'image',mime:'image/png',url:'http://127.0.0.1/'}]},validator),rejection(400,'invalid_request'));
  await assert.rejects(validateSend({...payload,messages:[{type:'image',mime:'image/png',data_base64:'file:///etc/passwd'}]},validator),rejection(400,'invalid_image'));
});
