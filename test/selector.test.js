'use strict';
// Uses a loopback MOCK API and temporary state only. Never connects to the real relay.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const http=require('node:http');
const {spawn}=require('node:child_process');
const source=path.resolve(__dirname,'..');
async function main(){
  const state=fs.mkdtempSync(path.join(require('node:os').tmpdir(),'arlab-selector-'));
  const deviceId='a'.repeat(32);
  fs.mkdirSync(path.join(state,'sessions'));
  fs.writeFileSync(path.join(state,'local-api-token.txt'),'MOCK-ONLY-NOT-A-REAL-TOKEN');
  fs.writeFileSync(path.join(state,'sessions','review.json'),JSON.stringify({deviceId,
    rootPackageName:'ctrip.english',refs:{'@e1':{viewId:'ctrip.english:id/action',text:'Search',
      className:'android.widget.Button',packageName:'ctrip.english',enabled:true}}}));
  let sent;
  const server=http.createServer((req,res)=>{
    let text='';req.on('data',b=>text+=b);req.on('end',()=>{
      if(req.url==='/status')res.end(JSON.stringify({ok:true,selectedDeviceId:deviceId,active:{deviceId},
        controlLease:{owner:'review-mock',expiresAt:new Date(Date.now()+3600000).toISOString()}}));
      else if(req.url==='/command'){
        sent=JSON.parse(text);res.end(JSON.stringify({ok:true,result:{performed:true}}));
      }else{res.statusCode=400;res.end(JSON.stringify({ok:false,error:'unexpected-mock-route'}));}
    });
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const config=path.join(state,'config.json');
  fs.writeFileSync(config,JSON.stringify({stateDir:state,runtimeDir:path.join(source,'src'),
    apiPort:server.address().port,ingressPort:server.address().port+1,publicPort:10000,
    relayHost:'mock.example.test',taskName:'mock-only'}));
  try{
    const child=spawn(process.execPath,[path.join(source,'src/client.js'),'click','@e1','review'],{
      windowsHide:true,env:{...process.env,ANDROID_REMOTE_LAB_CONFIG:config,
      ANDROID_REMOTE_LAB_STATE_DIR:state,ANDROID_REMOTE_LAB_API_PORT:String(server.address().port),
      ANDROID_REMOTE_LAB_OWNER:'review-mock'}});
    let error='';child.stderr.on('data',b=>error+=b);
    const code=await new Promise((r,j)=>{child.on('error',j);child.on('close',r)});
    assert.equal(code,0,error);
    assert.deepEqual(sent.args.selector,{expectedPackage:'ctrip.english',packageName:'ctrip.english',className:'android.widget.Button',viewId:'ctrip.english:id/action',text:'Search'});
    assert.equal(sent.args.expectedPackage,undefined);
    assert.equal(sent.deviceId,deviceId);
    console.log(JSON.stringify({defectReproduced:false,deviceBindingRetained:true,
      selector:sent.args.selector,expectedPackagePresent:true,textAndClassDropped:false}));
  }finally{server.close();}
}
main().catch(e=>{console.error(e);process.exitCode=1});
