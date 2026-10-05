#!/usr/bin/env node
import http from 'node:http';
import fs from 'node:fs';
import {WebSocketServer} from 'ws';
const port=Number(process.argv.find(x=>x.startsWith('--remote-debugging-port=')).split('=')[1]);
fs.appendFileSync(process.env.TEST_CHROME_LAUNCH_LOG, `${process.pid}\n`);
let ready=true;
const server=http.createServer((req,res)=>{
 if(req.url==='/freeze'){ready=false;res.end('frozen');return}
 res.writeHead(ready?200:503,{'content-type':'application/json'});
 res.end(JSON.stringify({webSocketDebuggerUrl:`ws://127.0.0.1:${port}/fake`}));
}).listen(port,'127.0.0.1');
const wss=new WebSocketServer({server});
process.on('SIGTERM',()=>{for(const client of wss.clients)client.terminate();wss.close();server.close(()=>process.exit(0))});
