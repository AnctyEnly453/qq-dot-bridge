import test from 'node:test';
import assert from 'node:assert/strict';
import {MEDIA_LIMITS,IMAGE_MIMES,MediaFailure,validateImageBytes,validateMessages,normalizeMessages} from '../src/media_messages.mjs';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=','base64');
const image=(bytes=png,mime='image/png')=>({type:'image',mime,data_base64:bytes.toString('base64')});
const options={decodeImage:async()=>{}}; // Only tests the contract; never a production decoder.
const rejects=(fn,status,code)=>assert.rejects(fn,e=>e instanceof MediaFailure&&e.status===status&&e.code===code);

test('text compatibility, literal CQ text and OneBot normalization',async()=>{
  const messages=[{type:'text',text:'你好🙂[CQ:image,file=x]'},{type:'face',id:14},image()];
  let calls=0;
  const actual=await normalizeMessages(messages,{decodeImage:async(bytes,mime)=>{calls++;assert.deepEqual(bytes,png);assert.equal(mime,'image/png');}});
  assert.deepEqual(actual,[{type:'text',data:{text:messages[0].text}},{type:'face',data:{id:'14'}},{type:'image',data:{file:'base64://'+png.toString('base64')}}]);
  assert.equal(calls,1);
  assert.deepEqual(await validateMessages(messages,options),messages);
});

test('face IDs retain existing 0..500 integer policy',async()=>{
  for(const id of [0,14,500])assert.deepEqual(await normalizeMessages([{type:'face',id}]),[{type:'face',data:{id:String(id)}}]);
  for(const id of [-1,501,1.5,'14',NaN,Infinity,null,true])await rejects(()=>validateMessages([{type:'face',id}]),400,'invalid_request');
  await rejects(()=>validateMessages([{type:'face',id:14,extra:1}]),400,'invalid_request');
});

test('limits apply to total text, message count and image count',async()=>{
  await validateMessages([{type:'text',text:'🙂'.repeat(2000)}]);
  for(const messages of [[],Array(9).fill({type:'face',id:1}),[{type:'text',text:''}],[{type:'text',text:'\0'}],[{type:'at',id:1}]])await rejects(()=>validateMessages(messages),400,'invalid_request');
  await rejects(()=>validateMessages([{type:'text',text:'x'.repeat(1001)},{type:'text',text:'y'.repeat(1000)}]),413,'message_too_large');
  await rejects(()=>validateMessages([image(),image()],options),413,'message_too_large');
});

test('strict base64 rejects malformed, alternate and noncanonical encodings before decoder',async()=>{
  let calls=0;const opts={decodeImage:async()=>{calls++;}};
  for(const data_base64 of ['',null,1,'!!!!','AAAA=','AAA','Zh==','AA==\n','AA-_','data:image/png;base64,AAAA','base64://AAAA'])await rejects(()=>validateMessages([{...image(),data_base64}],opts),400,'invalid_image');
  assert.equal(calls,0);
});

test('byte limits reject before decoding and allocating large base64 input',async()=>{
  let calls=0;const opts={decodeImage:async()=>{calls++;}};
  await rejects(()=>validateMessages([image(Buffer.alloc(MEDIA_LIMITS.imageBytes+1))],opts),413,'message_too_large');
  await rejects(()=>validateMessages([{...image(),data_base64:'A'.repeat(4*Math.ceil(MEDIA_LIMITS.imageBytes/3)+4)}],opts),413,'message_too_large');
  await rejects(()=>validateImageBytes(Buffer.alloc(MEDIA_LIMITS.imageBytes+1),'image/png',opts),413,'message_too_large');
  assert.equal(calls,0);
});

test('URL, local path and OneBot file input cannot trigger reads or fetches',async()=>{
  let calls=0;const opts={decodeImage:async()=>{calls++;}};
  for(const location of ['https://example.com/a.png','http://169.254.169.254/','file:///etc/passwd','C:\\Users\\a.png','/etc/passwd','../a.png']){
    await rejects(()=>validateMessages([{type:'image',url:location}],opts),400,'invalid_request');
    await rejects(()=>validateMessages([{type:'image',data:{file:location}}],opts),400,'invalid_request');
    await rejects(()=>validateMessages([{...image(),data_base64:location}],opts),400,'invalid_image');
    await rejects(()=>validateMessages([image(Buffer.from(location))],opts),400,'invalid_image');
  }
  await rejects(()=>validateImageBytes('file:///etc/passwd','image/png',opts),400,'invalid_image');
  assert.equal(calls,0);
});

test('fake format and MIME mismatch fail header preflight',async()=>{
  let calls=0;const opts={decodeImage:async()=>{calls++;}};
  for(const mime of IMAGE_MIMES)await rejects(()=>validateMessages([image(Buffer.from('not an image'),mime)],opts),400,'invalid_image');
  for(const mime of ['image/jpeg','image/gif','image/webp','image/svg+xml','image/PNG'])await rejects(()=>validateMessages([image(png,mime)],opts),400,'invalid_image');
  assert.equal(calls,0);
});

test('four allowed containers dispatch bytes to mandatory full decoder',async()=>{
  const webp=Buffer.alloc(20);webp.write('RIFF');webp.writeUInt32LE(12,4);webp.write('WEBPVP8 ',8);
  // Synthetic header fixtures establish dispatch only, not actual decodability.
  const samples=[png,Buffer.from([255,216,255,217]),Buffer.concat([Buffer.from('GIF89a'),Buffer.alloc(7),Buffer.from([59])]),webp];
  for(let i=0;i<IMAGE_MIMES.length;i++){
    let calls=0;await validateMessages([image(samples[i],IMAGE_MIMES[i])],{decodeImage:async(bytes,mime)=>{calls++;assert.deepEqual(bytes,samples[i]);assert.equal(mime,IMAGE_MIMES[i]);}});assert.equal(calls,1);
  }
});

test('header alone cannot pass; corrupt content rejection and decoder failures fail closed',async()=>{
  await rejects(()=>validateMessages([image()]),503,'media_unavailable');
  await rejects(()=>normalizeMessages([image(Buffer.from('89504e470d0a1a0a','hex'))],{decodeImage:async()=>{throw new MediaFailure(400,'invalid_image');}}),400,'invalid_image');
  for(const [error,status,code] of [[new MediaFailure(413,'message_too_large'),413,'message_too_large'],[new Error('private diagnostic'),503,'media_unavailable'],[new MediaFailure(503,'media_unavailable'),503,'media_unavailable']])await rejects(()=>validateMessages([image()],{decodeImage:async()=>{throw error;}}),status,code);
});

test('caller error factory bridges instanceof Failure and targets are outside API',async()=>{
  class BridgeFailure extends Error {constructor(status,code){super(code);this.status=status;this.code=code;}}
  await assert.rejects(validateMessages([{type:'face',id:'14'}],{errorFactory:(status,code)=>new BridgeFailure(status,code)}),e=>e instanceof BridgeFailure&&e.status===400);
  await rejects(()=>validateMessages({target:'1',messages:[{type:'text',text:'x'}]}),400,'invalid_request');
});


test('inclusive limits and Unicode code points are exact',async()=>{
  const text='\u{1F600}'.repeat(MEDIA_LIMITS.textCodePoints);
  assert.deepEqual(await validateMessages([{type:'text',text}]),[{type:'text',text}]);
  await rejects(()=>validateMessages([{type:'text',text:text+'x'}]),413,'message_too_large');
  assert.equal((await validateMessages(Array.from({length:8},()=>({type:'face',id:0})))).length,8);
  const bytes=Buffer.alloc(MEDIA_LIMITS.imageBytes);png.copy(bytes);
  let calls=0;
  await validateMessages([image(bytes)],{decodeImage:async b=>{calls++;assert.equal(b.length,MEDIA_LIMITS.imageBytes);}});
  assert.equal(calls,1); // Size contract only; padded PNG is not a full-decoder fixture.
});

test('image fields survive caller mutation during decoder await',async()=>{
  const item=image();const expected={...item};
  let release;const gate=new Promise(resolve=>{release=resolve;});
  const pending=normalizeMessages([item],{decodeImage:async()=>{await gate;}});
  item.mime='image/svg+xml';item.data_base64='https://example.com/changed.png';
  release();
  assert.deepEqual(await pending,[{type:'image',data:{file:'base64://'+expected.data_base64}}]);
});

test('all segment schemas reject missing and unexpected fields',async()=>{
  for(const value of [null,{},'text',[{type:'face',id:0}],{type:'text',text:'x',data:{}},{type:'face'},{type:'image',mime:'image/png'}, {...image(),file:'a.png'}, {...image(),url:'https://example.com'}]){
    await rejects(()=>validateMessages([value],options),400,'invalid_request');
  }
  for(const mime of ['image/jpg','IMAGE/PNG','image/png; charset=utf-8','image/bmp','image/svg+xml',null]){
    await rejects(()=>validateMessages([{...image(),mime}],options),400,'invalid_image');
  }
});

test('truncated signatures and invalid WebP container lengths reject before decoder',async()=>{
  const webp=Buffer.alloc(20);webp.write('RIFF');webp.writeUInt32LE(12,4);webp.write('WEBPVP8 ',8);
  const badLength=Buffer.from(webp);badLength.writeUInt32LE(13,4);
  const badChunk=Buffer.from(webp);badChunk.write('JUNK',12);
  let calls=0;const opts={decodeImage:async()=>{calls++;}};
  for(const [bytes,mime] of [[png.subarray(0,7),'image/png'],[Buffer.from([255,216,0,0]),'image/jpeg'],[Buffer.from('GIF89a'),'image/gif'],[webp.subarray(0,19),'image/webp'],[badLength,'image/webp'],[badChunk,'image/webp']]){
    await rejects(()=>validateImageBytes(bytes,mime,opts),400,'invalid_image');
  }
  assert.equal(calls,0);
});

test('base64 whitespace, padding, URLs and additional path schemes reject',async()=>{
  let calls=0;const opts={decodeImage:async()=>{calls++;}};
  for(const value of ['Zg=','Zg===','Zg== ',' Zg==','Z\ng==','Zm9=','//example.com/a.png','ftp://example.com/a.png','\\\\server\\share\\a.png','C:/a.png','file://C:/a.png','data:image/png;base64,'+png.toString('base64')]){
    await rejects(()=>validateMessages([{...image(),data_base64:value}],opts),400,'invalid_image');
    await rejects(()=>validateMessages([{type:'image',file:value}],opts),400,'invalid_request');
  }
  assert.equal(calls,0);
});
