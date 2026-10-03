// Tiled base-terrain map. Only visible tiles are requested, with two requests in flight.
const worldMap=(()=>{
  let result=null,canvas=null,ctx=null,host=null,readout=null,centre={x:0,z:0},bpp=4,width=0,height=420,drag=null,active=0;
  const cache=new Map(),pending=new Set(),failed=new Map();
  const colours={plains:'#83b75d',sunflower_plains:'#9fbf55',forest:'#447c40',flower_forest:'#608c53',birch_forest:'#69a057',old_growth_birch_forest:'#61914a',dark_forest:'#355039',pale_garden:'#8b9381',cherry_grove:'#d29eac',meadow:'#a3b86a',grove:'#82917f',taiga:'#688666',old_growth_pine_taiga:'#5e7960',old_growth_spruce_taiga:'#58745b',snowy_taiga:'#bbcabb',snowy_plains:'#d7e4df',snowy_slopes:'#c8d8d3',frozen_peaks:'#e4e8e5',jagged_peaks:'#a6aaa3',stony_peaks:'#a5aa88',desert:'#d9c587',beach:'#dccd9b',snowy_beach:'#d6dccd',stony_shore:'#a9aba0',badlands:'#bc7351',eroded_badlands:'#c68857',wooded_badlands:'#a57d46',savanna:'#b3b06b',savanna_plateau:'#a9a163',jungle:'#408548',bamboo_jungle:'#528d42',sparse_jungle:'#70a44f',swamp:'#68764d',mangrove_swamp:'#506549',mushroom_fields:'#af789d',dappled_forest:'#69825b',river:'#477fa4',ocean:'#326795',deep_ocean:'#254a76',cold_ocean:'#437c97',deep_cold_ocean:'#315c7b',frozen_ocean:'#95b6bf',deep_frozen_ocean:'#537e94',lukewarm_ocean:'#3a8a9f',deep_lukewarm_ocean:'#2c708b',warm_ocean:'#39a1ab'};
  const key=(seed,x,z,step)=>`${seed}:${x}:${z}:${step}`;
  function visible(){if(!result||!width)return [];const step=Math.max(4,Math.min(256,2**Math.ceil(Math.log2(bpp*4)))),span=step*32,left=centre.x-width*bpp/2,top=centre.z-height*bpp/2,tiles=[];
    for(let z=Math.floor(top/span)*span;z<top+height*bpp;z+=span)for(let x=Math.floor(left/span)*span;x<left+width*bpp;x+=span){if(Math.abs(x)>29990000||Math.abs(z)>29990000)continue;tiles.push({seed:result.seed,x,z,step,key:key(result.seed,x,z,step),distance:Math.hypot(x+span/2-centre.x,z+span/2-centre.z)})}
    return tiles.sort((a,b)=>a.distance-b.distance);
  }
  function bitmap(tile){const image=document.createElement('canvas');image.width=image.height=32;const c=image.getContext('2d'),pixels=c.createImageData(32,32);
    for(let i=0;i<1024;i++){let biome=tile.palette[tile.biomes[i]],colour=tile.water[i]?(biome.includes('frozen')?'#89a8b6':biome.includes('warm')?'#368ea5':'#397aa1'):(colours[biome]||'#7f9460');let rgb=colour.slice(1).match(/../g).map(v=>parseInt(v,16));let brightness=tile.water[i]?Math.max(.55,1-(63-tile.elevation[i])*.004):Math.max(.7,Math.min(1.25,1+tile.shade[i]*.012));for(let n=0;n<3;n++)pixels.data[i*4+n]=Math.min(255,rgb[n]*brightness);pixels.data[i*4+3]=255}
    c.putImageData(pixels,0,0);return image;
  }
  function pump(){if(!result)return;const needed=visible();for(const tile of needed){if(active>=2)break;if(cache.has(tile.key)||pending.has(tile.key)||(failed.get(tile.key)||0)>Date.now())continue;active++;pending.add(tile.key);
      api('/api/tile',tile).then(data=>{cache.set(tile.key,{data,image:bitmap(data)});while(cache.size>192)cache.delete(cache.keys().next().value)}).catch(e=>{failed.set(tile.key,Date.now()+10000);if(result?.seed===tile.seed)readout.textContent=`Map tile failed: ${e.message}`}).finally(()=>{active--;pending.delete(tile.key);draw();pump()});}
    const loaded=needed.filter(t=>cache.has(t.key)).length;$('map-scale').textContent=`${loaded}/${needed.length} tiles · ${needed[0]?.step||0} blocks/sample`;
  }
  function point(x,z){return {x:width/2+(x-centre.x)/bpp,y:height/2+(z-centre.z)/bpp}}
  function draw(){if(!canvas||!result)return;ctx.fillStyle='#152019';ctx.fillRect(0,0,width,height);ctx.imageSmoothingEnabled=false;
    // Cached coarse tiles are retained under newly requested detail tiles.
    const tiles=[...cache.values()].filter(t=>t.data.seed===result.seed).sort((a,b)=>b.data.step-a.data.step);
    for(const t of tiles){const p=point(t.data.x,t.data.z),size=t.data.step*32/bpp;if(p.x>width||p.y>height||p.x+size<0||p.y+size<0)continue;ctx.drawImage(t.image,p.x,p.y,size+.5,size+.5)}
    for(const t of visible())if(!cache.has(t.key)){const p=point(t.x,t.z),size=t.step*32/bpp;ctx.strokeStyle='#b9d6a322';ctx.strokeRect(p.x,p.y,size,size)}
    const spawn=point(result.spawnX,result.spawnZ);ctx.strokeStyle='#ffe2a2';ctx.lineWidth=2;ctx.beginPath();ctx.moveTo(spawn.x-6,spawn.y);ctx.lineTo(spawn.x+6,spawn.y);ctx.moveTo(spawn.x,spawn.y-6);ctx.lineTo(spawn.x,spawn.y+6);ctx.stroke();
    result.features.forEach((f,i)=>{const p=point(f.x,f.z);ctx.beginPath();ctx.arc(p.x,p.y,10,0,Math.PI*2);ctx.fillStyle=f.kind==='biome'?'#8de2ea':'#e1ed9e';ctx.fill();ctx.strokeStyle='#233120';ctx.stroke();ctx.fillStyle='#172019';ctx.font='bold 10px system-ui';ctx.textAlign='center';ctx.fillText(String(i+1),p.x,p.y+3)});
    ctx.textAlign='left';ctx.font='11px system-ui';ctx.fillStyle='#fff';ctx.fillText('N ↑',width-34,22);
  }
  function resize(){if(!canvas)return;width=host.clientWidth;const ratio=window.devicePixelRatio||1;canvas.width=Math.round(width*ratio);canvas.height=Math.round(height*ratio);canvas.style.width=`${width}px`;canvas.style.height=`${height}px`;ctx=canvas.getContext('2d');ctx.scale(ratio,ratio);draw();pump()}
  function update(){centre.x=Math.max(-29980000,Math.min(29980000,centre.x));centre.z=Math.max(-29980000,Math.min(29980000,centre.z));if(readout)readout.textContent=`Centre X ${Math.round(centre.x)}, Z ${Math.round(centre.z)} · drag to explore`;draw();pump()}
  function zoom(factor){bpp=Math.max(.25,Math.min(64,bpp*factor));update()}
  function describe(event){const rect=canvas.getBoundingClientRect(),x=Math.floor(centre.x+(event.clientX-rect.left-width/2)*bpp),z=Math.floor(centre.z+(event.clientY-rect.top-height/2)*bpp);let text=`X ${x}, Z ${z}`;
    const candidates=[...cache.values()].filter(t=>t.data.seed===result.seed&&x>=t.data.x&&z>=t.data.z&&x<t.data.x+t.data.step*32&&z<t.data.z+t.data.step*32).sort((a,b)=>a.data.step-b.data.step);
    if(candidates.length){const t=candidates[0].data,i=Math.floor((z-t.z)/t.step)*32+Math.floor((x-t.x)/t.step);text+=` · ${label(t.palette[t.biomes[i]])} · ground Y ${t.elevation[i]}`}
    for(const f of result.features){if(Math.hypot(f.x-x,f.z-z)<12*bpp)text+=` · ${label(f.key)}: X ${f.x}, Y ${f.y}, Z ${f.z}`}
    readout.textContent=text;
  }
  function show(value){if(!value)return;if(result?.seed===value.seed&&canvas?.isConnected){result=value;draw();return}result=value;centre={x:value.anchorX,z:value.anchorZ};bpp=4;host=$('map');host.className='terrain-map';host.innerHTML='<div class="map-tools"><button id="zoom-in" aria-label="Zoom map in">+</button><button id="zoom-out" aria-label="Zoom map out">−</button><button id="map-home">Spawn</button><button id="map-expand">Expand</button></div><canvas id="terrain-canvas" tabindex="0" role="img" aria-label="Scrollable snapshot terrain map"></canvas><div class="map-readout" id="map-readout">Drag to explore · scroll to zoom · arrow keys to pan</div><div class="map-key"></div>';
    canvas=$('terrain-canvas');readout=$('map-readout');host.querySelector('.map-key').textContent=value.features.map((f,i)=>`${i+1}. ${label(f.key)}`).join('  ·  ');
    $('map-title').textContent=`Seed ${value.seed}`;$('map-expand').textContent=host.closest('.map-panel').classList.contains('expanded')?'Close':'Expand';$('zoom-in').onclick=()=>zoom(.5);$('zoom-out').onclick=()=>zoom(2);$('map-home').onclick=()=>{centre={x:result.spawnX,z:result.spawnZ};update()};$('map-expand').onclick=()=>{host.closest('.map-panel').classList.toggle('expanded');height=host.closest('.map-panel').classList.contains('expanded')?Math.max(420,window.innerHeight-180):420;$('map-expand').textContent=height===420?'Expand':'Close';resize()};
    canvas.onpointerdown=e=>{canvas.focus();canvas.setPointerCapture(e.pointerId);drag={x:e.clientX,z:e.clientY,cx:centre.x,cz:centre.z};canvas.classList.add('dragging')};
    canvas.onpointermove=e=>{if(drag){centre={x:drag.cx-(e.clientX-drag.x)*bpp,z:drag.cz-(e.clientY-drag.z)*bpp};update()}describe(e)};
    canvas.onpointerup=canvas.onpointercancel=()=>{drag=null;canvas.classList.remove('dragging')};
    canvas.addEventListener('wheel',e=>{e.preventDefault();const rect=canvas.getBoundingClientRect(),dx=e.clientX-rect.left-width/2,dz=e.clientY-rect.top-height/2,old=bpp;zoom(e.deltaY>0?1.3:1/1.3);centre.x+=dx*(old-bpp);centre.z+=dz*(old-bpp);update()},{passive:false});
    canvas.onkeydown=e=>{const moves={ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,-1],ArrowDown:[0,1]};if(moves[e.key]){e.preventDefault();centre.x+=moves[e.key][0]*width*bpp*.4;centre.z+=moves[e.key][1]*height*bpp*.4;update()}else if(e.key==='+'||e.key==='=')zoom(.5);else if(e.key==='-')zoom(2)};
    resize();
  }
  window.addEventListener('resize',resize);return {show,clear(){host?.closest('.map-panel').classList.remove('expanded');height=420;result=null;canvas=null;host=null}};
})();
