"""Local-only browser UI and a persistent snapshot generation engine."""
import argparse, atexit, contextlib, copy, gzip, json, os, pathlib, secrets, sqlite3, subprocess, threading, time, webbrowser, urllib.request
from urllib.parse import urlsplit, parse_qs
from concurrent.futures import Future, ThreadPoolExecutor, as_completed
from collections import OrderedDict
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from build import ROOT, prepare
SAVED=ROOT/'saved-seeds.json'
CATALOGUE=ROOT/'catalogue.db'
TILE_POOL=ThreadPoolExecutor(48,thread_name_prefix='tile')

def number(request,key):
    try: return int(request[key])
    except (KeyError,TypeError,ValueError): raise ValueError(f'"{key}" must be a whole number.') from None

def conditions(request):
    """The part of a search request that decides which seeds match, in a canonical order."""
    keep={k:request[k] for k in ('anchor','biomeMode','cluster')}
    if request['anchor']=='custom': keep.update(x=request['x'],z=request['z'])
    keep['features']=sorted(({k:f[k] for k in ('kind','key','radius','mode','minRadius','count','id','near','variants','placements') if k in f} for f in request['features']),key=lambda f:json.dumps(f,sort_keys=True))
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

class Engine:
    def __init__(self):
        self.lock=threading.RLock(); self.write_lock=threading.Lock(); self.ready=threading.Event()
        self.catalog=None; self.failure=''; self.counter=0; self.pending={}
        self.tiles=OrderedDict(); self.tile_pending={}; self.structure_tiles=OrderedDict()
        self.catalogue=Catalogue(); self.jobs={}; self.stopping=False; self.busy=False
        self.state={'running':False,'tested':0,'matches':0,'seconds':0,'results':[],'error':'','engineRevision':2}
        command=prepare()
        self.log=open(ROOT/'runtime/engine.log','a',encoding='utf-8')
        self.process=subprocess.Popen(command,cwd=ROOT,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=self.log,text=True,encoding='utf-8',bufsize=1)
        saved=ROOT/'runtime/last-search.json'
        if saved.exists():
            try:
                previous=json.loads(saved.read_text(encoding='utf-8'))
                if previous.get('engineRevision')==2: self.state=previous;self.state.update(running=False,error='');self.state.pop('id',None)
            except (ValueError,OSError): pass
        threading.Thread(target=self.read,daemon=True).start()
    def read(self):
        for line in self.process.stdout:
            if not line.startswith('SEEDSCOUT '): continue
            event=json.loads(line[len('SEEDSCOUT '):])
            with self.lock:
                kind=event.get('type')
                if kind=='ready': self.catalog=event; self.ready.set()
                elif kind=='response':
                    waiter=self.pending.get(event['id'])
                    if waiter: waiter[1].append(event['data']); waiter[0].set()
                elif kind=='error':
                    waiter=self.pending.get(event.get('id'))
                    if waiter: waiter[1].append({'error':event['message']});waiter[0].set()
                    elif event.get('id') in self.jobs: self.jobs[event['id']].update(error=event['message']);self.jobs[event['id']]['done'].set()
                    elif event.get('id')==self.state.get('id'): self.state.update(error=event['message'],running=False)
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
            self.failure='Snapshot engine stopped. See runtime/engine.log.'
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
        target=ROOT/'runtime/last-search.json'; temp=target.with_suffix('.tmp')
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
    def validate(self,request):
        if self.catalog is None: raise ValueError('Snapshot engine is still starting.')
        features=request.get('features',[])
        if not 1<=len(features)<=12: raise ValueError('Select 1–12 features.')
        for f in features:
            if f.get('kind') not in ('structure','biome'): raise ValueError('Invalid feature type.')
            choices=self.catalog['sets' if f['kind']=='structure' else 'biomes']
            if f.get('key') not in choices: raise ValueError('Feature is not in this snapshot.')
            for field in ('variants','placements'):
                values=f.get(field)
                if values is None:
                    f.pop(field,None); continue
                variants=self.catalog.get('structureVariants',{}).get(f['key'],[]) if f['kind']=='structure' else []
                allowed=([self.catalog['variantDetails'][k] for k in variants] if field=='variants' else
                         [p for p in ('on_land_surface','partly_buried','on_ocean_floor','in_mountain','underground')
                          if f['key'] in ('ruined_portals','huge_ruined_portals') and f['key']+'_'+p in self.catalog['sets']])
                if not isinstance(values,list) or not values or any(not isinstance(v,str) or v not in allowed for v in values):
                    raise ValueError(f'Invalid {field} for this structure family.')
                values=sorted(set(values))
                if set(values)==set(allowed): f.pop(field,None)
                else: f[field]=values
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
            if self.state['running'] or self.busy: raise ValueError('Stop the current search before starting another.')
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
            with self.server.engine.lock: data=copy.deepcopy(self.server.engine.state);data.update(ready=self.server.engine.catalog is not None,catalog=self.server.engine.catalog)
            return self.reply(data)
        if self.path=='/api/saved': return self.reply({'seeds':self.server.engine.saved()})
        if self.path=='/api/catalogue': return self.reply({'finds':self.server.engine.catalogue.listing()})
        if self.path=='/api/catalogue-export':
            raw=json.dumps({'format':'seed-scout-catalogue','formatVersion':1,'exported':time.strftime('%Y-%m-%d %H:%M'),'finds':self.server.engine.catalogue.listing(export=True)},indent=1).encode()
            self.send_response(200);self.send_header('Content-Type','application/json');self.send_header('Content-Disposition','attachment; filename=seed-scout-catalogue.json');self.end_headers();self.wfile.write(raw);return
        if self.path=='/api/export':
            with self.server.engine.lock: return self.reply(self.server.engine.state)
        if self.path=='/api/export-file':
            target=ROOT/'runtime/exported-results.json'
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
            elif self.path=='/api/inspect': result=self.server.engine.inspect(request)
            elif self.path=='/api/tile': result=self.server.engine.tile(request)
            elif self.path=='/api/point': result=self.server.engine.map_request(request,'point')
            elif self.path=='/api/scan': result=self.server.engine.map_request(request,'scan')
            elif self.path=='/api/open': result=self.server.engine.map_request(request,'open')
            elif self.path=='/api/structures': result=self.server.engine.structures(request)
            elif self.path=='/api/structure': result=self.server.engine.structure(request)
            elif self.path=='/api/saved': result=self.server.engine.save_seed(request)
            elif self.path=='/api/saved-delete': result=self.server.engine.forget_seed(request)
            elif self.path=='/api/catalogue-delete': self.server.engine.catalogue.delete(int(request['id']));result={'finds':self.server.engine.catalogue.listing()}
            elif self.path=='/api/catalogue-import': result=self.server.engine.catalogue_import(request)
            elif self.path=='/api/export':
                target=ROOT/'runtime/exported-results.json'
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
    engine=Engine(); atexit.register(engine.close);server.engine=engine
    url=f'http://127.0.0.1:{server.server_port}'
    print('Seed Scout: '+url,flush=True)
    if not args.no_browser: webbrowser.open(url)
    try: server.serve_forever()
    finally: server.server_close();engine.close()
if __name__=='__main__': main()
