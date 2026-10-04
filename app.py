"""Local-only browser UI and a persistent snapshot generation engine."""
import argparse, atexit, contextlib, copy, gzip, json, os, pathlib, secrets, sqlite3, subprocess, threading, time, webbrowser, urllib.request
from urllib.parse import urlsplit, parse_qs
from concurrent.futures import Future, ThreadPoolExecutor, as_completed
from collections import OrderedDict
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from build import ROOT, DATA, prepare, chosen_version, installed_versions
SAVED=DATA/'saved-seeds.json'
CATALOGUE=DATA/'catalogue.db'
SETTINGS=DATA/'settings.json'
WORLD_EDGE=29999984
EMPTY_WORLD={'running':False,'seed':'','places':[],'regions':0,'ring':0,'covered':0,'seconds':0,'error':'','complete':False,'anchor':None}
TILE_POOL=ThreadPoolExecutor(48,thread_name_prefix='tile')

def number(request,key):
    try: return int(request[key])
    except (KeyError,TypeError,ValueError): raise ValueError(f'"{key}" must be a whole number.') from None

def conditions(request):
    """The part of a search request that decides which seeds match, in a canonical order."""
    keep={k:request[k] for k in ('anchor','biomeMode','cluster')}
    if request['anchor']=='custom': keep.update(x=request['x'],z=request['z'])
    keep['features']=sorted(({k:f[k] for k in ('kind','key','radius','mode','minRadius','count','id','near','variants','placements','templates','or') if k in f} for f in request['features']),key=lambda f:json.dumps(f,sort_keys=True))
    # Spawn conditions only appear when set, so searches without them keep the signature they always had.
    keep.update({k:request[k] for k in ('spawnBiomes','spawnBiomeMode','slime','landscape') if k in request})
    return keep
def closeness(result): return sum(f['distance'] for f in result['features'])

class Catalogue:
    """Rare finds: the conditions of a search that proved hard to satisfy, the seeds that met them, and how many
    seeds each run had to check. Rarity is seeds checked per match, which does not depend on the machine."""
    def __init__(self,path=CATALOGUE):
        self.path=path
        with self.db() as db: db.executescript("""
            CREATE TABLE IF NOT EXISTS finds(id INTEGER PRIMARY KEY, signature TEXT NOT NULL, version TEXT NOT NULL, conditions TEXT NOT NULL, created TEXT NOT NULL, imported INTEGER NOT NULL DEFAULT 0, UNIQUE(signature,version));
            CREATE TABLE IF NOT EXISTS runs(find_id INTEGER NOT NULL REFERENCES finds(id) ON DELETE CASCADE, start TEXT NOT NULL, tested INTEGER NOT NULL, matches INTEGER NOT NULL, seconds REAL NOT NULL, PRIMARY KEY(find_id,start));
            CREATE TABLE IF NOT EXISTS seeds(find_id INTEGER NOT NULL REFERENCES finds(id) ON DELETE CASCADE, seed TEXT NOT NULL, result TEXT NOT NULL, PRIMARY KEY(find_id,seed));""")
    @contextlib.contextmanager
    def db(self):
        db=sqlite3.connect(self.path);db.row_factory=sqlite3.Row;db.execute('PRAGMA foreign_keys=ON')
        try: yield db;db.commit()
        finally: db.close()
    def record(self,wanted,version,runs,results,threshold=None,imported=False):
        """Add runs and matching seeds to the find for these conditions. With a threshold, a new find is only created
        when the first run needed that many seeds per match; an existing find always grows."""
        signature=json.dumps(wanted,sort_keys=True,separators=(',',':'))
        with self.db() as db:
            row=db.execute('SELECT id FROM finds WHERE signature=? AND version=?',(signature,version)).fetchone()
            if row is None and threshold is not None and not (results and runs[0]['tested']/len(results)>=threshold): return None
            find=row['id'] if row else db.execute('INSERT INTO finds(signature,version,conditions,created,imported) VALUES(?,?,?,?,?)',(signature,version,json.dumps(wanted),time.strftime('%Y-%m-%d %H:%M'),int(imported))).lastrowid
            for run in runs:
                # Repeating a run from the same starting seed must not count its seeds twice.
                old=db.execute('SELECT tested FROM runs WHERE find_id=? AND start=?',(find,str(run['start']))).fetchone()
                if old is None or old['tested']<int(run['tested']): db.execute('INSERT OR REPLACE INTO runs VALUES(?,?,?,?,?)',(find,str(run['start']),int(run['tested']),int(run['matches']),float(run.get('seconds',0))))
            db.executemany('INSERT OR REPLACE INTO seeds VALUES(?,?,?)',[(find,r['seed'],json.dumps(r)) for r in results])
            return find
    def rarity(self,wanted,version):
        """Seeds checked, matches and seconds over every recorded run of exactly these conditions, or None."""
        signature=json.dumps(wanted,sort_keys=True,separators=(',',':'))
        with self.db() as db:
            row=db.execute('SELECT SUM(tested) AS tested,SUM(matches) AS matches,SUM(seconds) AS seconds FROM runs JOIN finds ON finds.id=find_id WHERE signature=? AND version=?',(signature,version)).fetchone()
        return dict(row) if row and row['tested'] and row['matches'] else None
    def seeds(self,version,limit=20000):
        with self.db() as db: return [r['seed'] for r in db.execute('SELECT DISTINCT seed FROM seeds JOIN finds ON finds.id=find_id WHERE version=? ORDER BY find_id DESC LIMIT ?',(version,limit))]
    def listing(self,export=False):
        with self.db() as db:
            finds=[]
            for f in db.execute('SELECT * FROM finds ORDER BY id DESC'):
                runs=[dict(r) for r in db.execute('SELECT start,tested,matches,seconds FROM runs WHERE find_id=? ORDER BY rowid',(f['id'],))]
                results=sorted((json.loads(r['result']) for r in db.execute('SELECT result FROM seeds WHERE find_id=?',(f['id'],))),key=closeness)
                tested,matched=sum(r['tested'] for r in runs),sum(r['matches'] for r in runs)
                if export: finds.append({'version':f['version'],'conditions':json.loads(f['conditions']),'created':f['created'],'runs':runs,'seeds':[r['seed'] for r in results]})
                else: finds.append({'id':f['id'],'version':f['version'],'conditions':json.loads(f['conditions']),'created':f['created'],'imported':bool(f['imported']),'tested':tested,'matches':matched,'seedsPerMatch':round(tested/matched) if matched else None,'seeds':results})
            return finds
    def delete(self,find):
        with self.db() as db: db.execute('DELETE FROM finds WHERE id=?',(find,))

def read_settings():
    try: return json.loads(SETTINGS.read_text(encoding='utf-8'))
    except (OSError,ValueError): return {}
def write_settings(patch):
    temp=SETTINGS.with_suffix('.tmp');temp.write_text(json.dumps({**read_settings(),**patch},indent=2),encoding='utf-8');os.replace(temp,SETTINGS)

class Engine:
    def __init__(self,version=None):
        self.version=version or chosen_version()
        self.lock=threading.RLock(); self.write_lock=threading.Lock(); self.ready=threading.Event()
        self.catalog=None; self.failure=''; self.counter=0; self.pending={}
        self.tiles=OrderedDict(); self.tile_pending={}; self.structure_tiles=OrderedDict()
        self.catalogue=Catalogue(); self.jobs={}; self.stopping=False; self.busy=False
        self.state={'running':False,'tested':0,'matches':0,'seconds':0,'results':[],'error':'','engineRevision':2}
        command=prepare(self.version)
        self.log=open(DATA/'runtime/engine.log','a',encoding='utf-8')
        self.process=subprocess.Popen(command,cwd=DATA,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=self.log,text=True,encoding='utf-8',bufsize=1)
        saved=DATA/'runtime/last-search.json'
        if saved.exists():
            try:
                previous=json.loads(saved.read_text(encoding='utf-8'))
                if previous.get('engineRevision')==2: self.state=previous;self.state.update(running=False,error='');self.state.pop('id',None)
            except (ValueError,OSError): pass
        # The search inside one seed: every place found so far and how far out it has looked, kept across restarts.
        self.world=copy.deepcopy(EMPTY_WORLD)
        try:
            kept=json.loads((DATA/'runtime/last-world-search.json').read_text(encoding='utf-8'))
            if isinstance(kept.get('places'),list): self.world={**self.world,**kept,'running':False,'error':''};self.world.pop('id',None)
        except (OSError,ValueError): pass
        threading.Thread(target=self.read,daemon=True).start()
    def read(self):
        for line in self.process.stdout:
            if not line.startswith('SEEDSCOUT '): continue
            event=json.loads(line[len('SEEDSCOUT '):])
            with self.lock:
                kind=event.get('type')
                if kind=='ready':
                    self.catalog=event
                    # A saved map worker count replaces the engine's default of half the cores.
                    chosen=self.settings().get('mapWorkers')
                    if isinstance(chosen,int) and 1<=chosen<=event['cores']: self.send({'cmd':'config','mapThreads':chosen});event['mapWorkers']=chosen
                    self.ready.set()
                elif kind=='response':
                    waiter=self.pending.get(event['id'])
                    if waiter: waiter[1].append(event['data']); waiter[0].set()
                elif kind=='error':
                    waiter=self.pending.get(event.get('id'))
                    if waiter: waiter[1].append({'error':event['message']});waiter[0].set()
                    elif event.get('id') in self.jobs: self.jobs[event['id']].update(error=event['message']);self.jobs[event['id']]['done'].set()
                    elif event.get('id')==self.state.get('id'): self.state.update(error=event['message'],running=False)
                    elif event.get('id')==self.world.get('id'): self.world.update(error=event['message'].split(': ',1)[-1],running=False)
                elif event.get('id')==self.world.get('id'):
                    world=self.world
                    if kind=='place':
                        place=event['data']
                        # A ring that was only partly covered before a stop is searched again; its places are already listed.
                        if len(world['places'])<5000 and all((p['x'],p['z'])!=(place['x'],place['z']) for p in world['places']):
                            world['places'].append(place);world['places'].sort(key=lambda p:p['distance']);self.save_world()
                    elif kind=='worldprogress':
                        world.update(regions=world['baseRegions']+event['regions'],seconds=world['baseSeconds']+event['seconds'],ring=max(world['fromRing'],event['ring']),
                                     covered=max(world.get('covered',0),event['covered']) if event['ring']>=world['fromRing'] else world.get('covered',0),
                                     running=event['running'],error=event.get('error',''),complete=event['complete'],anchor=event['anchor'],originX=event['originX'],originZ=event['originZ'])
                        if not event['running']: self.save_world()
                elif event.get('id') in self.jobs:
                    # A check over an explicit list of seeds (catalogue pass or import), collected for run_list.
                    job=self.jobs[event['id']]
                    if kind=='match': job['results'].append(event['data'])
                    elif kind=='progress':
                        job['tested']=event['tested']
                        if job['search']: self.state['catalogueChecked']=event['tested']
                        if not event['running']: job['error']=event.get('error','');job['done'].set()
                elif event.get('id')==self.state.get('id'):
                    if kind=='progress':
                        self.state.update({k:v for k,v in event.items() if k not in ('type','id','matches')})
                        self.state['matches']=len(self.state['results'])
                        if not event['running']: self.finish()
                    elif kind=='match' and all(r['seed']!=event['data']['seed'] for r in self.state['results']):
                        self.state['results'].append(event['data'])
                        self.state['results'].sort(key=closeness)
                        self.state['matches']=len(self.state['results'])
                        self.save_results()
        with self.lock:
            self.failure='The generation engine stopped unexpectedly. Restart Seed Scout; the reason is at the end of runtime/engine.log in its data folder.'
            self.state.update(running=False,error=self.failure); self.ready.set()
    def finish(self):
        """A search has ended: keep it in the catalogue if it turned out to be rare, then persist the results."""
        request=self.state['request'];fresh=[r for r in self.state['results'] if not r.get('fromCatalogue')]
        try:
            run={'start':request['seed'],'tested':self.state['tested'],'matches':len(fresh),'seconds':self.state['seconds']}
            find=self.catalogue.record(conditions(request),self.catalog['version'],[run],fresh,request['rareThreshold'])
            if find: self.state['catalogued']=find
        except sqlite3.Error as error: self.state['error']=f'The catalogue could not be updated: {error}'
        self.save_results()
    def run_list(self,request,seeds,search=False):
        """Check an explicit list of seeds against a request's conditions on the search workers."""
        job={'results':[],'tested':0,'error':'','search':search,'done':threading.Event()};ident=self.next_id()
        with self.lock: self.jobs[ident]=job
        try:
            self.send({**request,'cmd':'start','id':ident,'seeds':seeds})
            job['done'].wait()
            if job['error']: raise ValueError(job['error'])
            return job['results'],job['tested']
        finally:
            with self.lock: self.jobs.pop(ident,None)
    def launch(self,request):
        """Seeds already in the catalogue are checked against the new conditions before any new seed is tried."""
        try:
            known=self.catalogue.seeds(self.catalog['version']) if request['useCatalogue'] else [];found=[]
            if known:
                found,_=self.run_list(request,known,search=True)
                for result in found: result['fromCatalogue']=True
            with self.lock:
                if self.state.get('id')!=request['id']: return
                self.state.update(results=sorted(found,key=closeness),matches=len(found),catalogueMatches=len(found),catalogueChecked=len(known),phase='search')
                if self.stopping or len(found)>=request['maxMatches']:
                    self.state.update(running=False,nextSeed=request['seed']);self.save_results();return
                self.send({**request,'maxMatches':request['maxMatches']-len(found)})
        except (ValueError,OSError,sqlite3.Error) as error:
            with self.lock: self.state.update(running=False,error=str(error))
    def stop(self):
        self.stopping=True;self.send({'cmd':'stop'})
    def save_world(self):
        target=DATA/'runtime/last-world-search.json';temp=target.with_suffix('.tmp')
        temp.write_text(json.dumps(self.world),encoding='utf-8');os.replace(temp,target)
    def world_start(self,request):
        """Search inside one seed for every place where the conditions hold, or continue the last such search."""
        if self.catalog is None: raise ValueError('Snapshot engine is still starting.')
        with self.lock:
            if self.state['running'] or self.busy or self.world.get('running'): raise ValueError('Stop the current search before starting another.')
            old=self.world
        cores=max(8,int(self.catalog.get('cores',8)))
        if request.get('resume'):
            if not old.get('request') or old.get('complete'): raise ValueError('There is no unfinished search of a seed to continue.')
            wanted=copy.deepcopy(old['request']);places=old['places'];ring=old.get('ring',0)
            base=dict(baseSeconds=old.get('seconds',0),baseRegions=old.get('regions',0),covered=old.get('covered',0))
            for key in ('threads','maxMatches'):
                if key in request: wanted[key]=request[key]
        else:
            if not str(request.get('seed','')).strip(): raise ValueError('Enter the seed to search inside.')
            wanted=self.validate(copy.deepcopy(request));places=[];ring=0;base=dict(baseSeconds=0,baseRegions=0,covered=0)
            if any(c['kind']=='structure' and c['key'] in self.catalog.get('dimensions',{}) for f in wanted['features'] for c in [f,*f.get('or',[])]):
                raise ValueError('Searching inside one seed covers the Overworld only. Nether and End structures can be used when searching many seeds.')
            # Spawn conditions describe a seed, not a place in it.
            for key in ('spawnBiomes','spawnBiomeMode','slime','resume'): wanted.pop(key,None)
            if not any(f['mode']=='within' and not f.get('near') and not f.get('or') for f in wanted['features']):
                raise ValueError('Searching inside a seed needs at least one structure or biome you want to find (not one you avoid, and without alternatives).')
            wanted['range']=int(request.get('range') or WORLD_EDGE)
            if not 1024<=wanted['range']<=WORLD_EDGE: raise ValueError(f'Search between 1,024 and {WORLD_EDGE:,} blocks from the origin.')
        wanted['threads']=int(wanted.get('threads') or 4);wanted['maxMatches']=int(wanted.get('maxMatches') or 50)
        if not 1<=wanted['threads']<=cores: raise ValueError(f'Use 1–{cores} workers.')
        if not 1<=wanted['maxMatches']<=500: raise ValueError('Stop after 1–500 places; you can keep searching afterwards.')
        wanted={k:v for k,v in wanted.items() if k not in ('cmd','id','fromRing')}
        with self.lock:
            ident=self.next_id()
            self.world={**copy.deepcopy(EMPTY_WORLD),'id':ident,'running':True,'seed':wanted['seed'],'request':wanted,'places':places,'ring':ring,'fromRing':ring,
                        'range':wanted['range'],'regions':base['baseRegions'],'seconds':base['baseSeconds'],**base}
            self.send({**wanted,'cmd':'world','id':ident,'fromRing':ring,'known':[[p['x'],p['z']] for p in places]})
        return {'seed':wanted['seed']}
    def world_stop(self): self.send({'cmd':'worldstop'})
    def world_clear(self):
        with self.lock:
            if self.world.get('running'): raise ValueError('Stop the search first.')
            self.world=copy.deepcopy(EMPTY_WORLD)
            with contextlib.suppress(OSError): (DATA/'runtime/last-world-search.json').unlink()
        return {'ok':True}
    def catalogue_import(self,payload):
        if not isinstance(payload,dict) or payload.get('format')!='seed-scout-catalogue': raise ValueError('This is not a Seed Scout catalogue file.')
        with self.lock:
            if self.state['running'] or self.busy: raise ValueError('Wait for the current search to finish before importing.')
            self.busy=True
        summary={'finds':0,'seeds':0,'rejected':0,'otherVersion':0}
        try:
            for find in payload.get('finds',[])[:500]:
                if find.get('version')!=self.catalog['version']: summary['otherVersion']+=1;continue
                seeds=[str(int(s['seed'] if isinstance(s,dict) else s)) for s in find.get('seeds',[])][:2000]
                if not seeds: continue
                request=self.validate({**copy.deepcopy(find['conditions']),'seed':'0'})
                request.update(threads=min(16,max(1,int(self.catalog.get('cores',4))//2)),maxMatches=len(seeds))
                # Every imported seed is re-checked by this engine, so nothing in the file is taken on trust
                # except how many seeds the exporter says were searched.
                verified,_=self.run_list(request,seeds)
                summary['rejected']+=len(seeds)-len(verified)
                if not verified: continue
                self.catalogue.record(conditions(request),self.catalog['version'],find.get('runs',[])[:1000],verified,imported=True)
                summary['finds']+=1;summary['seeds']+=len(verified)
        finally: self.busy=False
        return summary
    def save_results(self):
        target=DATA/'runtime/last-search.json'; temp=target.with_suffix('.tmp')
        temp.write_text(json.dumps(self.state,indent=2),encoding='utf-8'); os.replace(temp,target)
    def saved(self):
        try: return json.loads(SAVED.read_text(encoding='utf-8'))
        except (OSError,ValueError): return []
    def write_saved(self,entries):
        temp=SAVED.with_suffix('.tmp');temp.write_text(json.dumps(entries,indent=2),encoding='utf-8');os.replace(temp,SAVED)
        return {'seeds':entries}
    def save_seed(self,request):
        seed=str(int(request['seed']))
        if not -(1<<63)<=int(seed)<(1<<63): raise ValueError('Seed must be a signed 64-bit number.')
        with self.lock:
            entries=self.saved();old=next((e for e in entries if e['seed']==seed),None)
            if old is None and len(entries)>=500: raise ValueError('The saved list is full (500 seeds). Remove one first.')
            entry=old or {'seed':seed,'note':'','saved':time.strftime('%Y-%m-%d %H:%M')}
            if 'note' in request:
                entry['note']=str(request['note'])
                if len(entry['note'])>4000: raise ValueError('Notes are limited to 4,000 characters.')
            if 'tags' in request:
                tags=request['tags']
                if not isinstance(tags,list) or len(tags)>10 or any(not isinstance(t,str) or not 1<=len(t.strip())<=24 for t in tags): raise ValueError('Use up to 10 tags of 1–24 characters.')
                entry['tags']=list(dict.fromkeys(t.strip().lower() for t in tags))
            if 'result' in request:
                # The search result as found, so the matches come back as markers when the seed is reopened.
                result=request['result']
                if not isinstance(result,dict) or str(result.get('seed'))!=seed or not isinstance(result.get('features'),list) or len(result['features'])>200: raise ValueError('Invalid saved result.')
                entry['result']=result
            if 'view' in request:
                entry['view']={k:float(request['view'][k]) for k in ('x','z','bpp')}
            if old is None: entries.insert(0,entry)
            return self.write_saved(entries)
    def forget_seed(self,request):
        seed=str(int(request['seed']))
        with self.lock: return self.write_saved([e for e in self.saved() if e['seed']!=seed])
    def send(self,request):
        with self.write_lock:
            self.process.stdin.write(json.dumps(request)+'\n'); self.process.stdin.flush()
    def next_id(self):
        with self.lock: self.counter+=1; return self.counter
    def validate_filters(self,f):
        for field in ('variants','placements','templates'):
            values=f.get(field)
            if values is None:
                f.pop(field,None); continue
            variants=self.catalog.get('structureVariants',{}).get(f['key'],[]) if f['kind']=='structure' else []
            allowed=(self.catalog.get('structureTemplates',{}).get(f['key'],[]) if field=='templates' and f['kind']=='structure' else
                     [self.catalog['variantDetails'][k] for k in variants] if field=='variants' else
                     [] if field=='templates' else
                     self.catalog.get('structurePlacements',{}).get('shipwrecks',[]) if f['kind']=='structure' and f['key']=='shipwrecks' else
                     [p for p in ('on_land_surface','partly_buried','on_ocean_floor','in_mountain','underground')
                      if f['key'] in ('ruined_portals','huge_ruined_portals') and f['key']+'_'+p in self.catalog['sets']])
            if not isinstance(values,list) or not values or any(not isinstance(v,str) or v not in allowed for v in values):
                raise ValueError(f'Invalid {field} for this structure family.')
            values=sorted(set(values))
            if set(values)==set(allowed): f.pop(field,None)
            else: f[field]=values
    def validate_landscape(self,request):
        """Conditions on the shape of the land: biome coverage, flat ground, high ground and a river."""
        items=request.get('landscape')
        if not items: request.pop('landscape',None); return
        if not isinstance(items,list) or len(items)>12: raise ValueError('Use up to 12 landscape conditions.')
        # A condition can be measured from the reported match of an Overworld structure or biome that is wanted nearby.
        anchors={f['key'] for f in request.get('features',[]) if f.get('mode','within')=='within' and not (f['kind']=='structure' and f['key'] in self.catalog.get('dimensions',{}))}
        def number(item,key,low,high,what):
            try: value=int(item.get(key))
            except (TypeError,ValueError): raise ValueError(f'{what} needs a number.') from None
            if not low<=value<=high: raise ValueError(f'{what} must be {low:,}–{high:,}.')
            return value
        cleaned=[]
        for index,item in enumerate(items):
            if not isinstance(item,dict): raise ValueError('Invalid landscape condition.')
            kind=item.get('type')
            if kind=='coverage':
                biomes=item.get('biomes')
                if not isinstance(biomes,list) or not biomes or any(b not in self.catalog['biomes'] for b in biomes): raise ValueError('Biome coverage needs at least one biome.')
                out={'biomes':sorted(set(biomes)),'share':number(item,'share',1,100,'The share of the area'),'mode':'max' if item.get('mode')=='max' else 'min','radius':number(item,'radius',32,4000,'The coverage distance')}
            elif kind=='flat':
                out={'share':number(item,'share',1,100,'The share of level ground'),'radius':number(item,'radius',32,4000,'The flat-ground distance'),'tolerance':number(item,'tolerance',0,64,'The height allowance')}
            elif kind=='hill':
                out={'rise':number(item,'rise',-64,320,'The height'),'measure':'y' if item.get('measure')=='y' else 'above','radius':number(item,'radius',64,4000,'The furthest distance to high ground'),
                     'minRadius':number(item,'minRadius',0,4000,'The nearest distance to high ground'),'across':number(item,'across',0,2000,'The width of the high ground')}
                if out['minRadius']>out['radius']-32: raise ValueError('High ground needs its nearest distance at least 32 blocks below its furthest.')
            elif kind=='river':
                out={'within':number(item,'within',16,2000,'The distance to the river'),'length':number(item,'length',32,4000,'The river length'),'width':number(item,'width',0,120,'The river width'),
                     'shape':item.get('shape') if item.get('shape') in ('fairly','very') else 'any'}
            else: raise ValueError('Unknown landscape condition.')
            source=item.get('from') or ''
            if source and source not in anchors: raise ValueError('A landscape condition can only be measured from a structure or biome you want nearby.')
            cleaned.append({'type':kind,**out,**({'from':source} if source else {}),'index':index})
        request['landscape']=cleaned
    def validate(self,request):
        if self.catalog is None: raise ValueError('Snapshot engine is still starting.')
        features=request.get('features',[])
        if len(features)>12: raise ValueError('Select up to 12 features.')
        if not features and not request.get('landscape') and not request.get('spawnBiomes') and not (isinstance(request.get('slime'),dict) and int(request['slime'].get('count') or 0)>0): raise ValueError('Select 1–12 features, a landscape condition or a spawn condition.')
        for f in features:
            if f.get('kind') not in ('structure','biome'): raise ValueError('Invalid feature type.')
            choices=self.catalog['sets' if f['kind']=='structure' else 'biomes']
            if f.get('key') not in choices: raise ValueError('Feature is not in this snapshot.')
            self.validate_filters(f)
            f['radius']=int(f['radius'])
            if not 32<=f['radius']<=8000: raise ValueError('Distances must be 32–8,000 blocks.')
            f['mode']=f.get('mode','within');f['minRadius']=int(f.get('minRadius',0));f['count']=int(f.get('count',1))
            if f['mode'] not in ('within','exclude'): raise ValueError('Feature mode must be "within" or "exclude".')
            if not 0<=f['minRadius']<=f['radius']-32: raise ValueError('Minimum distance must be 0 or more and at least 32 blocks below the maximum distance.')
            if not 1<=f['count']<=(10 if f['kind']=='structure' else 1): raise ValueError('Counts must be 1–10 for structures and 1 for biomes.')
            if f['mode']=='exclude' and (f['minRadius'] or f['count']!=1): raise ValueError('An excluded feature cannot have a minimum distance or a count.')
        # "near" measures a condition from the matches of another one, named by its "id", instead of from the search origin.
        ids={}
        for f in features:
            if not f.get('id'): f.pop('id',None); continue
            if not isinstance(f['id'],str) or len(f['id'])>80 or f['id'] in ids: raise ValueError('Condition ids must be short, unique strings.')
            ids[f['id']]=f
        for f in features:
            if not f.get('near'): f.pop('near',None); continue
            parent=ids.get(f['near'])
            if parent is None or parent is f or parent['kind']!='structure' or parent['mode']!='within' or parent.get('near'):
                raise ValueError('A condition can only be measured from a structure you want nearby that is itself measured from the search origin.')
            # The Overworld and the Nether are linked by portals; nothing in the End has a position in either.
            realm=lambda c: self.catalog.get('dimensions',{}).get(c['key'],'') if c['kind']=='structure' else ''
            if (realm(f)=='end')!=(realm(parent)=='end'): raise ValueError('An End structure can only be measured from another End structure.')
        # "or": other structures or biomes that satisfy the same condition at the same distances.
        parents={f['near'] for f in features if f.get('near')}
        for f in features:
            alternatives=f.get('or')
            if not alternatives: f.pop('or',None); continue
            if f['mode']!='within' or f.get('near') or f.get('id') in parents: raise ValueError('Alternatives are only for a condition you want nearby that is measured from the search origin and that nothing else is measured from.')
            if not isinstance(alternatives,list) or len(alternatives)>4: raise ValueError('A condition can have up to four alternatives.')
            cleaned=[]
            for a in alternatives:
                if not isinstance(a,dict) or a.get('kind') not in ('structure','biome') or a.get('key') not in self.catalog['sets' if a.get('kind')=='structure' else 'biomes']: raise ValueError('An alternative is not in this snapshot.')
                item={'kind':a['kind'],'key':a['key']}
                if item!={'kind':f['kind'],'key':f['key']} and item not in cleaned: cleaned.append(item)
            if cleaned: f['or']=cleaned
            else: f.pop('or',None)
        self.validate_landscape(request)
        biomes=request.get('spawnBiomes')
        if biomes:
            if not isinstance(biomes,list) or len(biomes)>30 or any(b not in self.catalog['biomes'] for b in biomes): raise ValueError('Invalid spawn biomes.')
            request['spawnBiomes']=sorted(set(biomes));request['spawnBiomeMode']='not' if request.get('spawnBiomeMode')=='not' else 'in'
        else: request.pop('spawnBiomes',None);request.pop('spawnBiomeMode',None)
        slime=request.get('slime')
        if isinstance(slime,dict) and int(slime.get('count') or 0)>0:
            radius,count=int(slime.get('radius',5)),int(slime['count'])
            if not 1<=radius<=8: raise ValueError('Slime chunks are counted within 1–8 chunks.')
            if count>(2*radius+1)**2: raise ValueError(f'There are only {(2*radius+1)**2} chunks within {radius} chunks.')
            request['slime']={'count':count,'radius':radius}
        else: request.pop('slime',None)
        request['biomeMode']=request.get('biomeMode','terrain')
        if request['biomeMode'] not in ('terrain','fast','exhaustive'): raise ValueError('Invalid biome search mode')
        request['anchor']=request.get('anchor','spawn')
        if request['anchor'] not in ('spawn','custom'): raise ValueError('Invalid search origin.')
        for key in ('x','z'): request[key]=int(request.get(key,0))
        if any(abs(request[k])>1000000 for k in ('x','z')): raise ValueError('Search coordinates must be within ±1,000,000.')
        request['cluster']=int(request.get('cluster',0))
        if not 0<=request['cluster']<=16000: raise ValueError('Invalid cluster distance.')
        seed=request.get('seed','') or str(secrets.randbits(64)-(1<<63))
        seed=str(int(seed))
        if not -(1<<63)<=int(seed)<(1<<63): raise ValueError('Seed must be a signed 64-bit number.')
        request['seed']=seed
        return request
    def start(self,request):
        request=self.validate(request)
        request['threads']=int(request.get('threads',4));request['limit']=int(request.get('limit',1000000));request['maxMatches']=int(request.get('maxMatches',20))
        cores=max(8,int(self.catalog.get('cores',8)))
        if not 1<=request['threads']<=cores: raise ValueError(f'Use 1–{cores} workers.')
        if not 1<=request['limit']<=10000000: raise ValueError('Search budget must be 1–10,000,000 seeds.')
        if not 1<=request['maxMatches']<=100: raise ValueError('Result limit must be 1–100.')
        request['rareThreshold']=int(request.get('rareThreshold',100000))
        if not 100<=request['rareThreshold']<=100000000: raise ValueError('The rare-find threshold must be 100–100,000,000 seeds per match.')
        request['useCatalogue']=bool(request.get('useCatalogue',True))
        with self.lock:
            if self.state['running'] or self.busy or self.world.get('running'): raise ValueError('Stop the current search before starting another.')
            request.update(cmd='start',id=self.next_id());self.stopping=False
            self.state={'id':request['id'],'running':True,'phase':'catalogue','tested':0,'matches':0,'seconds':0,'results':[],'error':'','catalogueChecked':0,'catalogueMatches':0,'request':copy.deepcopy(request),'engineRevision':2}
        threading.Thread(target=self.launch,args=(request,),daemon=True).start()
        return {'seed':request['seed']}
    def inspect(self,request):
        request=self.validate(request); request.update(cmd='inspect',id=self.next_id())
        return self.rpc(request)
    def tile(self,request):
        seed=str(int(request['seed']))
        x,z,step=(int(request[k]) for k in ('x','z','step'))
        if not -(1<<63)<=int(seed)<(1<<63) or step not in (1,2,4,8,16,32,64,128,256,512,1024): raise ValueError('Invalid map seed or scale')
        if abs(x)>29990000 or abs(z)>29990000: raise ValueError('Map is limited to the Minecraft world border')
        mode=request.get('mode','terrain')
        if mode not in ('terrain','overview','quick'): raise ValueError('Invalid map tile mode')
        # Old clients may request "overview"; it aliases the native terrain model. "quick" is the wide-view
        # biome map with estimated heights, which skips the terrain columns.
        if mode=='overview': mode='terrain'
        # Tests ask for the reference result: every column through the game's own getBaseColumn. It is not cached.
        if request.get('check')=='columns': return self.rpc(dict(cmd='tile',id=self.next_id(),seed=seed,x=x,z=z,step=step,mode=mode,check='columns'))
        key=(seed,x,z,step,mode)
        with self.lock:
            if key in self.tiles: self.tiles.move_to_end(key);return self.tiles[key]
            pending=self.tile_pending.get(key); owner=pending is None
            if owner: pending=self.tile_pending[key]=Future()
        if not owner: return pending.result(timeout=125)
        try:
            result=self.rpc(dict(cmd='tile',id=self.next_id(),seed=seed,x=x,z=z,step=step,mode=mode))
            with self.lock:
                self.tiles[key]=result
                while len(self.tiles)>1024: self.tiles.popitem(last=False)
            pending.set_result(result);return result
        except Exception as error:
            pending.set_exception(error);raise
        finally:
            with self.lock: self.tile_pending.pop(key,None)
    def tile_batch(self,request):
        """Several tiles of one seed, step and mode in a single request: browsers allow only six connections per
        host, fewer than the engine has map workers."""
        places=self.tile_places(request)
        jobs=[TILE_POOL.submit(self.tile,dict(request,x=x,z=z)) for x,z in places]
        return {'tiles':[job.result() for job in jobs]}
    @staticmethod
    def tile_places(request):
        places=[tuple(int(v) for v in place.split(',')) for place in request['at'].split(';')]
        if not 1<=len(places)<=16 or any(len(place)!=2 for place in places): raise ValueError('Ask for 1–16 tiles at a time')
        return places
    def settings(self): return read_settings()
    def estimate(self,request):
        """How rare these conditions were the last time they were searched: from the last search if it used them,
        else from the rare-find catalogue. Nothing is computed; an unseen combination has no estimate."""
        wanted=conditions(self.validate(copy.deepcopy(request)))
        with self.lock: last=copy.deepcopy(self.state)
        found=None
        if last.get('request') and last.get('tested') and conditions(last['request'])==wanted:
            fresh=sum(1 for r in last['results'] if not r.get('fromCatalogue'))
            if fresh: found={'tested':last['tested'],'matches':fresh,'seconds':last.get('seconds',0),'source':'last search'}
        if found is None:
            found=self.catalogue.rarity(wanted,self.catalog['version'])
            if found: found['source']='catalogue'
        if found is None: return {'known':False}
        return {'known':True,'source':found['source'],'matches':found['matches'],'seedsPerMatch':max(1,round(found['tested']/found['matches'])),
                'rate':round(found['tested']/found['seconds'],1) if found['seconds'] else None}
    def configure(self,request):
        if self.catalog is None: raise ValueError('Snapshot engine is still starting.')
        workers=number(request,'mapWorkers')
        if not 1<=workers<=self.catalog['cores']: raise ValueError(f"Use 1–{self.catalog['cores']} map workers.")
        with self.lock:
            write_settings({'mapWorkers':workers})
            self.send({'cmd':'config','mapThreads':workers});self.catalog['mapWorkers']=workers
        return {'mapWorkers':workers}
    def map_request(self,request,command):
        seed=str(int(request['seed']));x,z=int(request['x']),int(request['z'])
        if not -(1<<63)<=int(seed)<(1<<63) or max(abs(x),abs(z))>29980000: raise ValueError('Invalid map coordinates or seed')
        payload=dict(cmd=command,id=self.next_id(),seed=seed,x=x,z=z)
        if command=='scan':
            features=request.get('features',[])
            if not 1<=len(features)<=18: raise ValueError('Choose 1–18 map features')
            for f in features:
                if f.get('kind') not in ('structure','biome'): raise ValueError('Invalid map feature')
                if f.get('key') not in self.catalog['sets' if f['kind']=='structure' else 'biomes']: raise ValueError('Unknown map feature')
                self.validate_filters(f)
                f['radius']=int(f['radius'])
                if not 32<=f['radius']<=2000: raise ValueError('Map search radius must be 32–2,000 blocks')
            payload['features']=features
        return self.rpc(payload)
    def structures(self,request):
        if self.catalog is None: raise ValueError('Snapshot engine is still starting.')
        seed,x,z,size=(number(request,k) for k in ('seed','x','z','size'));keys=request.get('keys')
        if not -(1<<63)<=seed<(1<<63): raise ValueError('Seed must be a signed 64-bit number.')
        if size not in (1024,2048,4096,8192,16384,32768): raise ValueError('Structure tile size must be 1024, 2048, 4096, 8192, 16384 or 32768 blocks.')
        if x%size or z%size: raise ValueError('Structure tile x and z must be multiples of its size.')
        if max(abs(x),abs(z))>29980000: raise ValueError('Structure tiles are limited to the Minecraft world border.')
        if not isinstance(keys,list) or not 1<=len(keys)<=len(self.catalog['sets']): raise ValueError('Choose one or more structure types from the available options.')
        if any(k not in self.catalog['sets'] for k in keys): raise ValueError('Unknown structure type.')
        if len(set(keys))!=len(keys): raise ValueError('Structure types must not repeat.')
        keys=sorted(keys);key=(seed,x,z,size,tuple(keys))
        with self.lock:
            if key in self.structure_tiles: self.structure_tiles.move_to_end(key);return self.structure_tiles[key]
        result=self.rpc(dict(cmd='structures',id=self.next_id(),seed=str(seed),x=x,z=z,size=size,keys=keys))
        with self.lock:
            self.structure_tiles[key]=result
            while len(self.structure_tiles)>512: self.structure_tiles.popitem(last=False)
        return result
    def structure(self,request):
        if self.catalog is None: raise ValueError('Snapshot engine is still starting.')
        seed,x,z=(number(request,k) for k in ('seed','x','z'))
        if not -(1<<63)<=seed<(1<<63): raise ValueError('Seed must be a signed 64-bit number.')
        # A marker can lie up to one tile beyond the outermost tile corner.
        if max(abs(x),abs(z))>29980000+32768: raise ValueError('Structure position is outside the Minecraft world border.')
        if request.get('key') not in self.catalog['sets']: raise ValueError('Unknown structure type.')
        return self.rpc(dict(cmd='structure',id=self.next_id(),seed=str(seed),key=request['key'],x=x,z=z))
    def rpc(self,request):
        event=threading.Event(); result=[]
        with self.lock: self.pending[request['id']]=(event,result)
        try:
            self.send(request)
            if not event.wait(120): raise ValueError('Seed check timed out; engine log may contain details.')
            if 'error' in result[0]: raise ValueError(result[0]['error'])
            return result[0]
        finally:
            with self.lock: self.pending.pop(request['id'],None)
    def close(self):
        if self.process.poll() is None:
            try: self.process.stdin.close();self.process.wait(timeout=5)
            except (OSError,subprocess.TimeoutExpired): self.process.terminate()
        self.log.close()

SWITCHING=threading.Lock()
def switch_version(server,request):
    """Restart the engine on another installed Minecraft version. The new version is compiled first, so one the
    engine does not support is refused with nothing changed."""
    version=str(request.get('version',''))
    if version not in [v['id'] for v in installed_versions()]: raise ValueError('That Minecraft version is not installed.')
    with SWITCHING:
        old=server.engine
        with old.lock:
            if old.state['running'] or old.busy or old.world.get('running'): raise ValueError('Stop the current search before changing the Minecraft version.')
        if version==old.version: return {'version':version}
        try: prepare(version)
        except (RuntimeError,OSError) as error: raise ValueError(str(error)) from None
        # Two engines cannot share the data folder, so the old one stops before the new one starts.
        old.close()
        try:
            engine=server.engine=Engine(version)
            engine.ready.wait(180)
            if engine.catalog is None: raise RuntimeError(f'Minecraft {version} compiled, but its engine did not start (see runtime/engine.log).')
        except (RuntimeError,OSError) as error:
            with contextlib.suppress(Exception): server.engine.close()
            server.engine=Engine(old.version)
            raise ValueError(f'{error} Seed Scout is back on {old.version}.') from None
        write_settings({'version':version})
        return {'version':version}

class Handler(BaseHTTPRequestHandler):
    def log_message(self,*args): pass
    def reply(self,obj,status=200,cache='no-store'):
        raw=json.dumps(obj,separators=(',',':')).encode();self.send_response(status);self.send_header('Content-Type','application/json');self.send_header('Cache-Control',cache)
        self.send_header('Vary','Accept-Encoding')
        if len(raw)>1024 and 'gzip' in self.headers.get('Accept-Encoding',''):
            raw=gzip.compress(raw,compresslevel=1);self.send_header('Content-Encoding','gzip')
        self.send_header('Content-Length',str(len(raw)));self.end_headers();self.wfile.write(raw)
    def trusted(self):
        host=self.headers.get('Host','')
        if host not in (f'127.0.0.1:{self.server.server_port}',f'localhost:{self.server.server_port}'): return False
        origin=self.headers.get('Origin')
        return origin is None or origin in (f'http://127.0.0.1:{self.server.server_port}',f'http://localhost:{self.server.server_port}')
    def do_GET(self):
        if not self.trusted(): return self.reply({'error':'Invalid local origin'},403)
        if urlsplit(self.path).path=='/api/tile-stream':
            # Deliver completed tiles immediately. A difficult column must not hold all its neighbours hostage.
            try:
                query=parse_qs(urlsplit(self.path).query)
                request={k:query[k][0] for k in ('seed','step','mode','at')}
                places=self.server.engine.tile_places(request)
            except (ValueError,KeyError,TypeError) as error: return self.reply({'error':str(error)},400)
            jobs={TILE_POOL.submit(self.server.engine.tile,dict(request,x=x,z=z)):i for i,(x,z) in enumerate(places)}
            self.send_response(200);self.send_header('Content-Type','application/x-ndjson')
            self.send_header('Cache-Control','no-store');self.send_header('Connection','close');self.end_headers()
            self.close_connection=True
            try:
                for job in as_completed(jobs):
                    try: record={'index':jobs[job],'tile':job.result()}
                    except Exception as error: record={'index':jobs[job],'error':str(error)}
                    self.wfile.write((json.dumps(record,separators=(',',':'))+'\n').encode());self.wfile.flush()
            except (BrokenPipeError,ConnectionResetError,ConnectionAbortedError): pass
            finally:
                # Panning away closes the stream. Cancel queued work; already-running native tiles finish and cache.
                for job in jobs: job.cancel()
            return
        if urlsplit(self.path).path=='/api/tile':
            try:
                query=parse_qs(urlsplit(self.path).query)
                request={k:query[k][0] for k in ('seed','x','z','step','mode','check') if k!='check' or k in query}
                return self.reply(self.server.engine.tile(request),cache='private, max-age=31536000, immutable')
            except (ValueError,KeyError,TypeError) as error: return self.reply({'error':str(error)},400)
        if urlsplit(self.path).path=='/api/tiles':
            try:
                query=parse_qs(urlsplit(self.path).query)
                request={k:query[k][0] for k in ('seed','step','mode','at')}
                return self.reply(self.server.engine.tile_batch(request),cache='private, max-age=31536000, immutable')
            except (ValueError,KeyError,TypeError) as error: return self.reply({'error':str(error)},400)
        if self.path=='/api/status':
            with self.server.engine.lock: data=copy.deepcopy(self.server.engine.state);data.update(ready=self.server.engine.catalog is not None,catalog=self.server.engine.catalog,world={k:v for k,v in self.server.engine.world.items() if k!='id'})
            return self.reply(data)
        if self.path=='/api/versions': return self.reply({'current':self.server.engine.version,'versions':installed_versions()})
        if self.path=='/api/saved': return self.reply({'seeds':self.server.engine.saved()})
        if self.path=='/api/catalogue': return self.reply({'finds':self.server.engine.catalogue.listing()})
        if self.path=='/api/catalogue-export':
            raw=json.dumps({'format':'seed-scout-catalogue','formatVersion':1,'exported':time.strftime('%Y-%m-%d %H:%M'),'finds':self.server.engine.catalogue.listing(export=True)},indent=1).encode()
            self.send_response(200);self.send_header('Content-Type','application/json');self.send_header('Content-Disposition','attachment; filename=seed-scout-catalogue.json');self.end_headers();self.wfile.write(raw);return
        if self.path=='/api/export':
            with self.server.engine.lock: return self.reply(self.server.engine.state)
        if self.path=='/api/export-file':
            target=DATA/'runtime/exported-results.json'
            if not target.exists(): return self.reply({'error':'Export results first'},404)
            raw=target.read_bytes();self.send_response(200);self.send_header('Content-Type','application/json');self.send_header('Content-Disposition','attachment; filename=seed-scout-results.json');self.end_headers();self.wfile.write(raw);return
        # Any page, script or stylesheet directly inside web/ is served; nothing outside it.
        types={'html':'text/html; charset=utf-8','js':'text/javascript','css':'text/css'}
        name=self.path.split('?')[0].lstrip('/') or 'index.html';path=ROOT/'web'/name
        if '/' in name or '\\' in name or path.suffix[1:] not in types or not path.is_file(): return self.reply({'error':'Not found'},404)
        raw=path.read_bytes()
        self.send_response(200);self.send_header('Content-Type',types[path.suffix[1:]])
        self.send_header('Cache-Control','no-cache');self.end_headers();self.wfile.write(raw)
    def do_POST(self):
        if not self.trusted() or self.headers.get('Content-Type','').split(';')[0]!='application/json': return self.reply({'error':'Invalid local request'},403)
        try:
            size=int(self.headers.get('Content-Length','0'))
            if not 0<size<=(20<<20 if self.path=='/api/catalogue-import' else 65536): raise ValueError('Invalid request size')
            request=json.loads(self.rfile.read(size))
            if self.path=='/api/start': result=self.server.engine.start(request)
            elif self.path=='/api/stop': self.server.engine.stop();result={'ok':True}
            elif self.path=='/api/world-start': result=self.server.engine.world_start(request)
            elif self.path=='/api/world-stop': self.server.engine.world_stop();result={'ok':True}
            elif self.path=='/api/world-clear': result=self.server.engine.world_clear()
            elif self.path=='/api/inspect': result=self.server.engine.inspect(request)
            elif self.path=='/api/tile': result=self.server.engine.tile(request)
            elif self.path=='/api/point': result=self.server.engine.map_request(request,'point')
            elif self.path=='/api/scan': result=self.server.engine.map_request(request,'scan')
            elif self.path=='/api/open': result=self.server.engine.map_request(request,'open')
            elif self.path=='/api/structures': result=self.server.engine.structures(request)
            elif self.path=='/api/structure': result=self.server.engine.structure(request)
            elif self.path=='/api/saved': result=self.server.engine.save_seed(request)
            elif self.path=='/api/saved-delete': result=self.server.engine.forget_seed(request)
            elif self.path=='/api/config': result=self.server.engine.configure(request)
            elif self.path=='/api/estimate': result=self.server.engine.estimate(request)
            elif self.path=='/api/version': result=switch_version(self.server,request)
            elif self.path=='/api/catalogue-delete': self.server.engine.catalogue.delete(int(request['id']));result={'finds':self.server.engine.catalogue.listing()}
            elif self.path=='/api/catalogue-import': result=self.server.engine.catalogue_import(request)
            elif self.path=='/api/export':
                target=DATA/'runtime/exported-results.json'
                with self.server.engine.lock: exported=copy.deepcopy(self.server.engine.state)
                exported['results']=request.get('results',exported['results'])
                target.write_text(json.dumps(exported,indent=2),encoding='utf-8')
                result={'saved':str(target),'url':'/api/export-file'}
            elif self.path=='/api/shutdown': self.reply({'ok':True});threading.Thread(target=self.server.shutdown,daemon=True).start();return
            else: return self.reply({'error':'Not found'},404)
            self.reply(result)
        except (ValueError,KeyError,TypeError,BrokenPipeError) as error: self.reply({'error':str(error)},400)

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--port',type=int,default=8877);parser.add_argument('--no-browser',action='store_true');args=parser.parse_args()
    url=f'http://127.0.0.1:{args.port}'
    try:
        with urllib.request.urlopen(url+'/api/status',timeout=.5) as response: existing=json.load(response)
        if 'catalog' in existing and 'tested' in existing:
            print('Seed Scout is already open: '+url,flush=True)
            if not args.no_browser: webbrowser.open(url)
            return
    except (OSError,ValueError): pass
    server=ThreadingHTTPServer(('127.0.0.1',args.port),Handler)
    # The desktop shell shows these lines while it waits: the stage being worked on, or why starting failed.
    print(f'Seed Scout stage: Compiling the engine against Minecraft {chosen_version()}',flush=True)
    try: server.engine=Engine()
    except (RuntimeError,OSError) as error:
        print(f'Seed Scout error: {error}',flush=True);server.server_close();raise SystemExit(2) from None
    atexit.register(lambda: server.engine.close())
    url=f'http://127.0.0.1:{server.server_port}'
    print('Seed Scout: '+url,flush=True)
    if not args.no_browser: webbrowser.open(url)
    try: server.serve_forever()
    finally: server.server_close();server.engine.close()
if __name__=='__main__': main()
