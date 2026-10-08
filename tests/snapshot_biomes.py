"""Run native Snapshot 3 cave-search checks with isolated compilation and storage."""
import os,pathlib,subprocess,sys,tempfile
ROOT=pathlib.Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT))
base=ROOT/'runtime/search-bench';base.mkdir(parents=True,exist_ok=True)
out=pathlib.Path(tempfile.mkdtemp(prefix='snapshot-biomes-',dir=base))
os.environ['SEED_SCOUT_DATA']=str(out);os.environ['SEED_SCOUT_VERSION']='26.4-snapshot-3'
from build import prepare,JDK
prepare()
args=[s.strip().strip('"') for s in (out/'runtime/engine.args').read_text().splitlines()];cp=args[args.index('-cp')+1]
classes=out/'classes';classes.mkdir()
for name,exe,arguments in [('compile','javac.exe',['-cp',cp,'-d',str(classes),str(ROOT/'tests/SnapshotBiomesTest.java')]),('test','java.exe',['-Xmx3G','-cp',str(classes)+os.pathsep+cp,'SnapshotBiomesTest'])]:
    argfile=out/(name+'.args');argfile.write_text('\n'.join('"'+s.replace('\\','/')+'"' for s in arguments))
    with (out/(name+'.log')).open('w') as log:
        subprocess.run([str(JDK/'bin'/exe),'@'+str(argfile)],cwd=out,stdout=log,stderr=subprocess.STDOUT,check=True,timeout=180)
print((out/'test.log').read_text().splitlines()[-1]);print('Artifacts:',out)
