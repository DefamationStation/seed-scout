"""Cold-tile engine benchmark: same requests, isolated JVM, no user data changes."""
import argparse,pathlib,subprocess,json,time,hashlib,threading,queue
ROOT=pathlib.Path(__file__).resolve().parents[1]
p=argparse.ArgumentParser();p.add_argument('--classes',required=True);p.add_argument('--output',required=True);a=p.parse_args()
out=pathlib.Path(a.output).resolve();out.mkdir(parents=True,exist_ok=False)
args=[s.strip().strip('"') for s in (ROOT/'runtime/engine.args').read_text().splitlines()];i=args.index('-cp')+1
args[i]=str(pathlib.Path(a.classes).resolve())+';'+args[i].split(';',1)[1]
argfile=out/'engine.args';argfile.write_text('\n'.join('"'+s.replace('\\','/')+'"' for s in args))
log=(out/'stderr.log').open('w');proc=subprocess.Popen([str(ROOT.parent/'.tools/jdk-25.0.4.1+1/bin/java.exe'),'@'+str(argfile)],cwd=out,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=log,text=True,encoding='utf-8')
q=queue.Queue()
def read():
 for line in proc.stdout:
  if line.startswith('SEEDSCOUT '):q.put(json.loads(line[10:]))
threading.Thread(target=read,daemon=True).start()
def event():
 e=q.get(timeout=120)
 if e['type']=='error':raise RuntimeError(e)
 return e
while event()['type']!='ready':pass
report=[];serial=0
try:
 for mode,step in [('quick',32),('terrain',1),('terrain',2),('terrain',4),('terrain',8),('terrain',16),('quick',128)]:
  # Warm code/worker states, then three independent cold 48-tile views.
  for repeat in range(4):
   jobs={};start=time.perf_counter();data={};lat=[]
   for n in range(48):
    serial+=1;r=dict(cmd='tile',id=serial,seed='-3811937398911504802',x=(100+n%8+repeat*20)*32*step,z=(100+n//8)*32*step,step=step,mode=mode);jobs[serial]=n
    proc.stdin.write(json.dumps(r)+'\n')
   proc.stdin.flush()
   for n in range(48):
    e=event();data[jobs[e['id']]]=e['data'];lat.append(time.perf_counter()-start)
   digest=hashlib.sha256(json.dumps([data[n] for n in range(48)],sort_keys=True).encode()).hexdigest()
   row=dict(mode=mode,step=step,repeat=repeat,warmup=repeat==0,seconds=lat[-1],first=lat[0],half=lat[23],sha256=digest)
   report.append(row);print(json.dumps(row),flush=True)
   (out/'results.json').write_text(json.dumps(report,indent=2))
finally:
 proc.stdin.close();proc.wait(timeout=30);log.close()
