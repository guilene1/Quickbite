import {createClient} from 'redis';
const client=createClient({url:process.env.REDIS_URL||'redis://redis:6379'});
client.on('error',e=>console.error('Redis:',e.message));
async function run(){await client.connect();console.log('QuickBite notification worker started');while(true){try{const result=await client.brPop('quickbite:notifications',5);if(result){const event=JSON.parse(result.element);console.log('SIMULATED NOTIFICATION:',JSON.stringify(event));}}catch(e){console.error('Worker error:',e.message);await new Promise(r=>setTimeout(r,2000));}}}
run().catch(e=>{console.error(e);process.exit(1)});
