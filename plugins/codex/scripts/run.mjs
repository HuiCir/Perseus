// Start native Codex with exactly the user's arguments. The plugin must already
// be installed/trusted; Actor settings belong to the native session.
import { spawn } from 'node:child_process';
import { discoverCodex } from '../src/rpc.mjs';
const {executable}=await discoverCodex();
const child=spawn(executable,process.argv.slice(2),{stdio:'inherit',env:process.env});
child.on('error',()=>{process.exitCode=1;});
child.on('exit',(code,signal)=>{if(signal)process.kill(process.pid,signal);else process.exitCode=code??1;});
