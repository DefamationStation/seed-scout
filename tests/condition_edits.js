// A visible unblurred edit must reach the search request and survive opening subcategories.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const app = fs.readFileSync('web/app.js', 'utf8');
const id = 'structure:huge_ruined_portals';
const condition = {kind:'structure',key:'huge_ruined_portals',radius:1000,minRadius:0,count:2,placements:['on_land_surface']};
const chosen = new Map([[id,condition]]);
let inputs = ['count','minRadius','radius'].map(field=>({dataset:{id,field},value:field==='radius'?'100':field==='count'?'1':'0'}));
const context = {chosen,fields:['radius'],$:key=>key==='chosen'?{querySelectorAll:()=>inputs}:{value:'1000'},
  mergeFamilyConditions:()=>{},renderFeatures:()=>{},renderChosen:()=>{},save:()=>{},familyName:x=>x,isPortalFamily:()=>true};
const core = app.slice(app.indexOf('function updateConditionField('),app.indexOf("$('features').onchange"));
vm.runInNewContext(core+'\nglobalThis.buildRequest=request;',context);
let request = context.buildRequest();
assert.equal(request.features[0].radius,100);assert.equal(request.features[0].count,1);
assert.deepEqual(Array.from(request.features[0].placements),['on_land_surface']);
// Increasing the maximum must preserve a minimum that is valid within the new range.
condition.radius=32;
inputs.find(i=>i.dataset.field==='radius').value='1000';
inputs.find(i=>i.dataset.field==='minRadius').value='100';
request=context.buildRequest();assert.equal(request.features[0].minRadius,100);
// A chooser rebuild reads the fields before replacing their DOM nodes.
inputs.find(i=>i.dataset.field==='radius').value='200';
context.$=key=>key==='chosen'?{querySelectorAll:()=>inputs}:key==='subcategory-dialog'?{showModal:()=>{}}:{};
const chooser=app.slice(app.indexOf('function openSubcategories('),app.indexOf('function renderSubcategories('));
context.renderSubcategories=()=>{};
vm.runInNewContext(chooser+'\nopenSubcategories("huge_ruined_portals","find");',context);
assert.equal(condition.radius,200);assert.equal(condition.minRadius,100);
console.log('Pending distance/count edits reach requests and survive subcategory changes.');
