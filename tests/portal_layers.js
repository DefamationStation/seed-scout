// Verify giant-only filtering while both layers share requests and physical marker IDs.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {setImmediate: tick} = require('node:timers/promises');
const source = fs.readFileSync('web/map.js', 'utf8').replace('    show, clear, on, flyTo,', `
    test: { setup() { result={seed:'123'}; centre={x:1024,z:1024}; width=200; height=200; bpp=4; },
      pumpFeatures, collect, markerId, featureRequestKey, variantShown, markers:()=>markerList },
    show, clear, on, flyTo,`) + '\nglobalThis.map=worldMap;';
const calls = [], elements = new Map();
const portals = [
  {kind:'structure',key:'ruined_portals',x:1000,z:1000,portalSize:'huge',detail:'ruined_portal',placement:'on_land_surface'},
  {kind:'structure',key:'ruined_portals',x:1200,z:1200,portalSize:'regular',detail:'ruined_portal',placement:'underground'},
];
const context = {
  structuredClone, Map, Set, Date, Math,
  catalog:{sets:['ruined_portals','huge_ruined_portals','huge_ruined_portals_on_land_surface','huge_ruined_portals__ruined_portal']},
  terrain:{}, localStorage:{getItem:()=>null,setItem:()=>{}},
  setTimeout:()=>1, clearTimeout:()=>{}, requestAnimationFrame:()=>1,
  $:id=>{if(!elements.has(id))elements.set(id,{});return elements.get(id);},
  api:(path,request)=>{calls.push(request);return Promise.resolve({features:portals,limited:[]});},
};
vm.runInNewContext(source,context);
const map=context.map, test=map.test;
(async()=>{
  assert.deepEqual(Array.from(map.features(),f=>f.key),['huge_ruined_portals','ruined_portals']);
  const huge=map.features().find(f=>f.key==='huge_ruined_portals');
  assert(test.variantShown(huge,portals[0]));assert(!test.variantShown(huge,portals[1]));
  assert(!test.variantShown({...huge,placements:['underground']},portals[0]));
  assert.equal(test.markerId(portals[0]),test.markerId({...portals[0],key:'huge_ruined_portals'}));
  assert.equal(test.featureRequestKey('huge_ruined_portals',2048),'ruined_portals');
  assert.equal(test.featureRequestKey('huge_ruined_portals',16384),'huge_ruined_portals');
  test.setup();test.pumpFeatures();await tick();
  assert.equal(calls.length,1,'Both enabled layers fetch one shared tile');
  test.collect();assert.equal(test.markers().length,2,'Both enabled layers draw each physical portal once');
  assert.equal(test.markers().find(f=>f.portalSize==='huge').key,'huge_ruined_portals');
  map.setFeature('ruined_portals',{on:false});test.collect();
  assert.equal(test.markers().length,1);assert.equal(test.markers()[0].portalSize,'huge');
  console.log('Huge portal layer filtering, shared requests, wide tile isolation, and marker deduplication passed.');
})().catch(e=>{console.error(e);process.exitCode=1;});
