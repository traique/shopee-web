import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';

test('Chromium startup is shared; failed DevTools and stop/start cannot leave overlapping processes',async()=>{
 const temp=await fs.mkdtemp(path.join(os.tmpdir(),'cdp-test-'));
 const listener=net.createServer();await new Promise(resolve=>listener.listen(0,'127.0.0.1',resolve));
 const port=listener.address().port;await new Promise(resolve=>listener.close(resolve));
 Object.assign(process.env,{CHROME_EXECUTABLE:path.resolve('test/fixtures/fake-chromium.mjs'),CHROME_DEBUG_PORT:String(port),CHROME_PROFILE_DIR:path.join(temp,'profile'),CHROME_START_TIMEOUT_MS:'3000',TEST_CHROME_LAUNCH_LOG:path.join(temp,'launches')});
 const chrome=await import('../src/chromium.js');
 try {
  const urls=await Promise.all(Array.from({length:5},()=>chrome.ensureChromiumReady()));
  assert.equal(new Set(urls).size,1);
  const first=chrome.chromiumStatus().pid;
  assert.equal((await fs.readFile(process.env.TEST_CHROME_LAUNCH_LOG,'utf8')).trim().split('\n').length,1);
  await new Promise((resolve,reject)=>http.get(`http://127.0.0.1:${port}/freeze`,res=>{res.resume();res.on('end',resolve)}).on('error',reject));
  await chrome.ensureChromiumReady();
  const second=chrome.chromiumStatus().pid;assert.notEqual(first,second);
  assert.throws(()=>process.kill(first,0),{code:'ESRCH'});
  const stopping=chrome.stopChromium(),restarting=chrome.ensureChromiumReady();
  await Promise.all([stopping,restarting]);
  assert.notEqual(chrome.chromiumStatus().pid,second);
  assert.throws(()=>process.kill(second,0),{code:'ESRCH'});
 } finally {await chrome.stopChromium();await fs.rm(temp,{recursive:true,force:true})}
 assert.equal(chrome.chromiumStatus().running,false);
});
