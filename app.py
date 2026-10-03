"""Local-only browser UI and a persistent snapshot generation engine."""
import argparse, atexit, copy, json, os, pathlib, secrets, subprocess, threading, time, webbrowser, urllib.request
from collections import OrderedDict
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from build import ROOT, prepare

class Engine:
    def __init__(self):
        self.lock=threading.RLock(); self.write_lock=threading.Lock(); self.ready=threading.Event()
        self.catalog=None; self.failure=''; self.counter=0; self.pending={}
        self.tiles=OrderedDict()
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
                    elif event.get('id')==self.state.get('id'): self.state.update(error=event['message'],running=False)
                elif event.get('id')==self.state.get('id'):
                    if kind=='progress':
                        self.state.update({k:v for k,v in event.items() if k not in ('type','id')})
                        if not event['running']: self.save_results()
                    elif kind=='match':
                        self.state['results'].append(event['data'])
                        self.state['results'].sort(key=lambda r:sum(f['distance'] for f in r['features']))
                        self.save_results()
        with self.lock:
            self.failure='Snapshot engine stopped. See runtime/engine.log.'
            self.state.update(running=False,error=self.failure); self.ready.set()
    def save_results(self):
        target=ROOT/'runtime/last-search.json'; temp=target.with_suffix('.tmp')
        temp.write_text(json.dumps(self.state,indent=2),encoding='utf-8'); os.replace(temp,target)
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
            f['radius']=int(f['radius'])
            if not 32<=f['radius']<=8000: raise ValueError('Distances must be 32–8,000 blocks.')
        request['biomeMode']=request.get('biomeMode','terrain')
        if request['biomeMode'] not in ('terrain','fast'): raise ValueError('Invalid biome search mode')
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
        request['threads']=int(request.get('threads',4));request['limit']=int(request.get('limit',100000));request['maxMatches']=int(request.get('maxMatches',20))
        if not 1<=request['threads']<=8: raise ValueError('Use 1–8 workers.')
        if not 1<=request['limit']<=10000000: raise ValueError('Search budget must be 1–10,000,000 seeds.')
        if not 1<=request['maxMatches']<=100: raise ValueError('Result limit must be 1–100.')
        with self.lock:
            if self.state['running']: raise ValueError('Stop the current search before starting another.')
            request.update(cmd='start',id=self.next_id())
            self.state={'id':request['id'],'running':True,'tested':0,'matches':0,'seconds':0,'results':[],'error':'','request':copy.deepcopy(request),'engineRevision':2}
            self.send(request)
        return {'seed':request['seed']}
    def inspect(self,request):
        request=self.validate(request); request.update(cmd='inspect',id=self.next_id())
        return self.rpc(request)
    def tile(self,request):
        seed=str(int(request['seed']))
        x,z,step=(int(request[k]) for k in ('x','z','step'))
        if not -(1<<63)<=int(seed)<(1<<63) or step not in (4,8,16,32,64,128,256): raise ValueError('Invalid map seed or scale')
        if abs(x)>29990000 or abs(z)>29990000: raise ValueError('Map is limited to the Minecraft world border')
        key=(seed,x,z,step)
        with self.lock:
            if key in self.tiles: self.tiles.move_to_end(key);return self.tiles[key]
        result=self.rpc(dict(cmd='tile',id=self.next_id(),seed=seed,x=x,z=z,step=step))
        with self.lock:
            self.tiles[key]=result
            while len(self.tiles)>256: self.tiles.popitem(last=False)
        return result
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
    def reply(self,obj,status=200):
        raw=json.dumps(obj).encode();self.send_response(status);self.send_header('Content-Type','application/json');self.send_header('Cache-Control','no-store');self.end_headers();self.wfile.write(raw)
    def trusted(self):
        host=self.headers.get('Host','')
        if host not in (f'127.0.0.1:{self.server.server_port}',f'localhost:{self.server.server_port}'): return False
        origin=self.headers.get('Origin')
        return origin is None or origin in (f'http://127.0.0.1:{self.server.server_port}',f'http://localhost:{self.server.server_port}')
    def do_GET(self):
        if not self.trusted(): return self.reply({'error':'Invalid local origin'},403)
        if self.path=='/api/status':
            with self.server.engine.lock: data=copy.deepcopy(self.server.engine.state);data.update(ready=self.server.engine.catalog is not None,catalog=self.server.engine.catalog)
            return self.reply(data)
        if self.path=='/api/export':
            with self.server.engine.lock: return self.reply(self.server.engine.state)
        if self.path=='/api/export-file':
            target=ROOT/'runtime/exported-results.json'
            if not target.exists(): return self.reply({'error':'Export results first'},404)
            raw=target.read_bytes();self.send_response(200);self.send_header('Content-Type','application/json');self.send_header('Content-Disposition','attachment; filename=seed-scout-results.json');self.end_headers();self.wfile.write(raw);return
        files={'/':'index.html','/app.js':'app.js','/map.js':'map.js','/style.css':'style.css'}
        if self.path not in files: return self.reply({'error':'Not found'},404)
        path=ROOT/'web'/files[self.path];raw=path.read_bytes()
        self.send_response(200);self.send_header('Content-Type',{'html':'text/html; charset=utf-8','js':'text/javascript','css':'text/css'}[path.suffix[1:]])
        self.send_header('Cache-Control','no-cache');self.end_headers();self.wfile.write(raw)
    def do_POST(self):
        if not self.trusted() or self.headers.get('Content-Type','').split(';')[0]!='application/json': return self.reply({'error':'Invalid local request'},403)
        try:
            size=int(self.headers.get('Content-Length','0'))
            if not 0<size<=65536: raise ValueError('Invalid request size')
            request=json.loads(self.rfile.read(size))
            if self.path=='/api/start': result=self.server.engine.start(request)
            elif self.path=='/api/stop': self.server.engine.send({'cmd':'stop'});result={'ok':True}
            elif self.path=='/api/inspect': result=self.server.engine.inspect(request)
            elif self.path=='/api/tile': result=self.server.engine.tile(request)
            elif self.path=='/api/point': result=self.server.engine.map_request(request,'point')
            elif self.path=='/api/scan': result=self.server.engine.map_request(request,'scan')
            elif self.path=='/api/open': result=self.server.engine.map_request(request,'open')
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
