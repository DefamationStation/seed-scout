const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {setImmediate: tick} = require('node:timers/promises');
const source = fs.readFileSync('web/map.js','utf8').replace('    show, clear, on, flyTo,', `    test: { set(x) { result = {seed:'123'}; centre = {x,z:0}; width=600; height=600; bpp=3; }, pump, cache, pending, tileStreams, active:()=>active },
    show, clear, on, flyTo,`) + '\nglobalThis.map = worldMap;';
const elements = new Map(), calls=[];
const context = { structuredClone, Map, Set, Date, Math, AbortController, TextDecoder, URLSearchParams,
 localStorage:{getItem:()=>null}, catalog:{mapWorkers:16,sets:[]}, terrain:{sampleOffset:s=>(1-s)/2},
 setTimeout:()=>1,clearTimeout:()=>{},requestAnimationFrame:()=>1,
 $:id=>{if(!elements.has(id))elements.set(id,{textContent:'',hidden:true,firstElementChild:{style:{}}});return elements.get(id);},
 fetch:(url,{signal})=>{let stream; const body=new ReadableStream({start(c){stream=c;signal.addEventListener('abort',()=>c.error(new DOMException('Aborted','AbortError')));}});
 const params=new URL(url,'http://localhost').searchParams;calls.push({params,stream,signal});return Promise.resolve({ok:true,body});},
};
vm.runInNewContext(source,context);
const test=context.map.test, encoder=new TextEncoder();
function send(call,index) {
 const [x,z]=call.params.get('at').split(';')[index].split(',').map(Number);
 const tile={seed:'123',x,z,step:Number(call.params.get('step')),mode:call.params.get('mode'),size:32,palette:['plains'],biomes:[],elevation:[],water:[]};
 call.stream.enqueue(encoder.encode(JSON.stringify({index,tile})+'\n'));
}
(async()=>{
 test.set(0);test.pump();assert(calls.length>0);const first=calls[0];
 send(first,0);await tick();assert.equal(test.cache.size,1,'A tile must appear before the stream closes');
 test.set(100000);test.pump();await tick();
 assert(first.signal.aborted,'A stream outside the new viewport must be aborted');
 assert(calls.some(c=>!c.signal.aborted&&c.params.get('at').includes('99')),'New view starts without old stream completing');
 assert(test.active()<=3,'Requests remain bounded');
 for(let round=0;round<30;round++) {
  const open=calls.filter(c=>!c.signal.aborted&&!c.finished);
  if(!open.length)break;
  for(const c of open){c.finished=true;const n=c.params.get('at').split(';').length;for(let i=0;i<n;i++)send(c,i);c.stream.close();}
  await tick();
 }
 assert.equal(test.active(),0);assert.equal(test.pending.size,0);
 assert.match(elements.get('status-tiles').textContent,/8 blocks per sample/);
 console.log('Streaming display, obsolete-request cancellation, bounded concurrency, and complete viewport passed.');
})().catch(e=>{console.error(e);process.exitCode=1});

