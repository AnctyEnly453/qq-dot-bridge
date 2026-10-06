const unicode=value=>{for(let i=0;i<value.length;i++){const n=value.charCodeAt(i);if(n>=0xD800&&n<=0xDBFF){const next=value.charCodeAt(++i);if(!(next>=0xDC00&&next<=0xDFFF))throw new TypeError('invalid unicode');}else if(n>=0xDC00&&n<=0xDFFF)throw new TypeError('invalid unicode');}};
export function compactStringify(value) {
  const seen=new Set();
  const check=v=>{
    if(v===null||typeof v==='boolean')return;
    if(typeof v==='string'){unicode(v);return;}
    if(typeof v==='number'){if(!Number.isFinite(v))throw new TypeError('invalid JSON number');return;}
    if(typeof v!=='object'||seen.has(v))throw new TypeError('invalid JSON value');
    if(![Object.prototype,Array.prototype,null].includes(Object.getPrototypeOf(v)))throw new TypeError('invalid JSON object');
    seen.add(v);const descriptors=Object.getOwnPropertyDescriptors(v);
    if(Object.getOwnPropertySymbols(v).length)throw new TypeError('invalid JSON key');
    if(Array.isArray(v)&&Object.keys(v).length!==v.length)throw new TypeError('sparse JSON array');
    for(const [key,d] of Object.entries(descriptors)){if(Array.isArray(v)&&key==='length')continue;unicode(key);if(!d.enumerable||!('value' in d))throw new TypeError('invalid JSON property');check(d.value);}
    seen.delete(v);
  };
  check(value);return JSON.stringify(value);
}
export const compactBytes=value=>Buffer.from(compactStringify(value),'utf8');
export function parseCompact(body) {
  if(!Buffer.isBuffer(body))throw new TypeError('JSON bytes required');
  const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(body));
  if(!compactBytes(value).equals(body))throw new TypeError('noncanonical JSON');
  return value;
}
