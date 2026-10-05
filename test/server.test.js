import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {WebSocket} from 'ws';
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function freePort(){const s=net.createServer();await new Promise(resolve=>s.listen(0,'127.0.0.1',resolve));const port=s.address().port;await new Promise(resolve=>s.close(resolve));return port}
test('idle bridge releases Chromium, preserves an active client, and rejects unauthorised discovery',{timeout:25000},async()=>{
 const temp=await fs.mkdtemp(path.join(os.tmpdir(),'cdp-server-'));
 const port=await freePort(),chromePort=await freePort(),token='t'.repeat(40);
 const child=spawn(process.execPath,['src/server.js'],{env:{...process.env,PORT:String(port),CDP_TOKEN:token,CHROME_IDLE_TIMEOUT_MS:'5000',CHROME_DEBUG_PORT:String(chromePort),CHROME_EXECUTABLE:path.resolve('test/fixtures/fake-chromium.mjs'),CHROME_PROFILE_DIR:path.join(temp,'profile'),CHROME_START_TIMEOUT_MS:'3000',TEST_CHROME_LAUNCH_LOG:path.join(temp,'launches')},stdio:['ignore','pipe','pipe']});
 let logs='';child.stdout.on('data',chunk=>{logs+=chunk});child.stderr.on('data',chunk=>{logs+=chunk});
 let external;
 const base=`http://127.0.0.1:${port}`;
 try {
  for(let i=0;i<100&&!logs.includes('[server] listening');i++)await delay(20);
  assert.equal(child.exitCode,null,logs);
  assert.equal((await fetch(`${base}/cdp/wrong/json/version`)).status,404);
  assert.equal((await (await fetch(`${base}/healthz`)).json()).chromium.running,false);
  const discovery=await fetch(`${base}/cdp/${token}/json/version`);
  assert.equal(discovery.status,200,logs);
  await delay(5500);
  assert.equal((await (await fetch(`${base}/healthz`)).json()).chromium.running,false,logs);
  const abandoned=net.connect(port,'127.0.0.1');
  await new Promise(resolve=>abandoned.once('connect',resolve));
  abandoned.write(`GET /cdp/${token} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`);
  let acquired=false;
  for(let i=0;i<100;i++){if((await (await fetch(`${base}/healthz`)).json()).activeClient){acquired=true;break}await delay(5)}
  assert.equal(acquired,true);abandoned.destroy();await delay(100);
  assert.equal((await (await fetch(`${base}/healthz`)).json()).activeClient,false,'aborted cold-start upgrade must release its slot');
  external=new WebSocket(`ws://127.0.0.1:${port}/cdp/${token}`);
  await new Promise((resolve,reject)=>{external.once('open',resolve);external.once('error',reject)});
  await delay(5500);
  const active=await (await fetch(`${base}/healthz`)).json();
  assert.equal(active.activeClient,true);assert.equal(active.chromium.running,true);
  const closed=new Promise(resolve=>external.once('close',resolve));external.close();await closed;
  await delay(5500);
  const idle=await (await fetch(`${base}/healthz`)).json();
  assert.equal(idle.activeClient,false);assert.equal(idle.chromium.running,false,logs);
 } finally {
  external?.terminate();
  const stopped=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGTERM');await stopped;
  await fs.rm(temp,{recursive:true,force:true});
 }
});
