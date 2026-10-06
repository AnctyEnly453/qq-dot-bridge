import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'qq-bridge-tests-'));
try {
  const config=JSON.parse(fs.readFileSync('config.example.json','utf8'));
  Object.assign(config,{audience:'https://deployment.example.invalid',self_id:'1000000004',allowed_privates:['1000000001','1000000002'],allowed_groups:['1000000003']});
  const filename=path.join(temp,'config.json');fs.writeFileSync(filename,JSON.stringify(config));
  const tests=fs.readdirSync('server/test').filter(n=>n.startsWith('test_')&&n.endsWith('.mjs')).map(n=>'server/test/'+n);
  const result=spawnSync(process.execPath,['--test',...tests],{stdio:'inherit',env:{...process.env,QQ_BRIDGE_CONFIG:filename}});
  process.exitCode=result.status??1;
  if (!process.exitCode) {
    for (const directory of ['client/tests','server/test']) {
      const check=spawnSync('python3',['-m','unittest','discover','-s',directory,'-p','test_*.py'],{stdio:'inherit'});
      if (check.status) {process.exitCode=check.status;break;}
    }
  }
} finally {fs.rmSync(temp,{recursive:true,force:true});}
