import fs from 'node:fs';
import {execFileSync} from 'node:child_process';
const files=execFileSync('git',['ls-files','-z'],{encoding:'utf8'}).split('\0').filter(Boolean);
if(!files.length)throw new Error('no_tracked_release_files');
const problems=[];
for(const file of files){
  if(/(^|\/)(identity|state|node_modules|__pycache__|\.venv)(\/|$)|(^|\/)config\.json$|\.(pem|key|sqlite3?|db|log|pyc|zip)$|(^|\/)\.env(?:\.|$)/.test(file))problems.push(file+': runtime file');
  if(fs.lstatSync(file).isSymbolicLink())problems.push(file+': symlink');
  const data=fs.readFileSync(file,'utf8');
  if(/-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/.test(data))problems.push(file+': private key material');
  if(/(?:ghp_|github_pat_)[A-Za-z0-9_]{20,}/.test(data))problems.push(file+': token pattern');
  if(/(?:\/Users\/|[A-Z]:[\\/]Users[\\/]|\/workspace\/scratch\/|\/root\/\.ssh)/.test(data))problems.push(file+': deployment-specific path');
  if(!file.includes('/test')&&file!=='scripts/check-release.mjs'){
    if(/["'][1-9][0-9]{7,10}["']/.test(data))problems.push(file+': account-like literal outside tests');
    const ips=data.match(/\b(?:[0-9]{1,3}\.){3}[0-9]{1,3}\b/g)||[];
    if(ips.some(ip=>!['127.0.0.1','0.0.0.0'].includes(ip)))problems.push(file+': non-loopback address');
  }
  if(file.endsWith('.mjs'))execFileSync(process.execPath,['--check',file],{stdio:'pipe'});
  if(file.endsWith('.py'))execFileSync('python3',['-c','import ast,sys; ast.parse(open(sys.argv[1],encoding="utf-8").read())',file],{stdio:'pipe'});
}
if(problems.length){process.stderr.write(problems.join('\n')+'\n');process.exitCode=1;}
else process.stdout.write(JSON.stringify({tracked_files:files.length,syntax_and_release_scan:'passed'})+'\n');
