"""Isolated engine benchmark; never calls the live web API or changes its saved state."""
import argparse,json,pathlib,subprocess,time,sys
ROOT=pathlib.Path(__file__).resolve().parents[1]
p=argparse.ArgumentParser();p.add_argument('--classes',required=True);p.add_argument('--output',required=True);p.add_argument('--threads',type=int,nargs='+',default=[4]);p.add_argument('--limit',type=int,default=100000);p.add_argument('--profile',action='store_true');a=p.parse_args()
out=pathlib.Path(a.output).resolve();out.mkdir(parents=True,exist_ok=False)
args=[s.strip().strip('"') for s in (ROOT/'runtime/engine.args').read_text().splitlines()];idx=args.index('-cp')+1
args[idx]=str(pathlib.Path(a.classes).resolve())+';'+args[idx].split(';',1)[1]
if a.profile:args.insert(0,'-XX:StartFlightRecording=settings=profile,duration=60s,filename='+str(out/'profile.jfr'))
argfile=out/'engine.args';argfile.write_text('\n'.join('"'+s.replace('\\','/')+'"' for s in args))
log=(out/'stderr.log').open('w');events=(out/'events.jsonl').open('w')
proc=subprocess.Popen([str(ROOT.parent/'.tools/jdk-25.0.4.1+1/bin/java.exe'),'@'+str(argfile)],cwd=out,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=log,text=True,encoding='utf-8')
(out/'pid').write_text(str(proc.pid));print('PID',proc.pid,flush=True)
def event():
 while True:
  line=proc.stdout.readline()
  if not line:raise RuntimeError('Engine stopped: '+str(proc.poll()))
  if line.startswith('SEEDSCOUT '):
   e=json.loads(line[10:]);events.write(json.dumps(e)+'\n');events.flush();return e
while event()['type']!='ready':pass
results=[]
try:
 for i,(threads,limit) in enumerate([(a.threads[0],10000)]+[(t,a.limit) for t in a.threads]):
  req=dict(cmd='start',id=i+1,seed='-3811937398911544709',anchor='spawn',threads=threads,limit=limit,maxMatches=100000,features=[dict(kind='structure',key='woodland_mansions',radius=100)])
  proc.stdin.write(json.dumps(req)+'\n');proc.stdin.flush();matches=[]
  while True:
   e=event()
   if e['type']=='error':raise RuntimeError(e)
   if e.get('id')!=i+1:continue
   if e['type']=='match':matches.append(e['data'])
   if e['type']=='progress' and not e['running']:
    assert not e['error'] and e['tested']==limit,e
    r=dict(threads=threads,warmup=i==0,tested=e['tested'],seconds=e['seconds'],seedsPerSecond=e['tested']/e['seconds'],matches=sorted(matches,key=lambda x:int(x['seed'])))
    results.append(r);(out/'results.json').write_text(json.dumps(results,indent=2));print(json.dumps({k:v for k,v in r.items() if k!='matches'})+' matches='+str(len(matches)),flush=True);break
finally:
 proc.stdin.close();proc.wait(timeout=30);log.close();events.close()
