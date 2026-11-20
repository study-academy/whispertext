import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {readFileSync} from 'node:fs';
const [helper,directory,...files]=process.argv.slice(2);
const child=spawn(helper,[directory],{stdio:['pipe','pipe','inherit']});
const lines=createInterface({input:child.stdout});
let pending;
child.on('exit',code=>{pending?.reject(new Error('Native helper exited: '+code));});
lines.on('line',line=>{let data;try{data=JSON.parse(line);}catch{return;}if(data.type==='progress'){console.log('progress',JSON.stringify(data));return;}if(pending&&data.id===pending.id){const p=pending;pending=null;data.error?p.reject(Error(data.error)):p.resolve(data);}});
let id=0;
const request=value=>new Promise((resolve,reject)=>{pending={id:++id,resolve,reject};child.stdin.write(JSON.stringify({id,...value})+'\n');});
try {
 if(files[0] === '--offline') { files.shift(); console.log('cold-local-load-only'); } else console.log('setup',await request({type:'setup'}));
 for(const file of files){
  // Fixtures were created locally by say + afconvert: RIFF PCM16 mono 16kHz.
  const bytes=readFileSync(file);let offset=12,pcm;
  while(offset+8<=bytes.length){const size=bytes.readUInt32LE(offset+4);if(bytes.toString('ascii',offset,offset+4)==='data'){pcm=bytes.subarray(offset+8,offset+8+size);break;}offset+=8+size+(size%2);}
  if(!pcm || pcm.length < 9600)throw Error('Missing or empty audio fixture');const samples=new Float32Array(pcm.length/2);for(let i=0;i<samples.length;i++)samples[i]=pcm.readInt16LE(i*2)/32768;
  console.log(file,await request({type:'transcribe',audio:Buffer.from(samples.buffer).toString('base64')}));
 }
}finally{child.kill();}
