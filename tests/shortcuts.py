"""Compile and run the placement and biome shortcut test in an isolated working directory."""
import pathlib,sys,subprocess,tempfile
ROOT=pathlib.Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT))
from build import prepare,JDK
prepare();base=ROOT/'runtime/search-bench';base.mkdir(parents=True,exist_ok=True)
out=pathlib.Path(tempfile.mkdtemp(prefix='shortcuts-test-',dir=base));classes=out/'classes';classes.mkdir()
args=[s.strip().strip('"') for s in (ROOT/'runtime/engine.args').read_text().splitlines()];cp=args[args.index('-cp')+1]
def run(exe,name,arguments):
 path=out/(name+'.args');path.write_text('\n'.join('"'+str(x).replace('\\','/')+'"' for x in arguments))
 with (out/(name+'.log')).open('w') as log:subprocess.run([str(JDK/'bin'/exe),'@'+str(path)],cwd=out,stdout=log,stderr=subprocess.STDOUT,check=True,timeout=900)
run('javac.exe','compile',['-cp',cp,'-d',classes,ROOT/'tests/ShortcutsTest.java'])
run('java.exe','test',['-Xmx3G','-cp',str(classes)+';'+cp,'ShortcutsTest'])
print((out/'test.log').read_text().splitlines()[-1]);print('Artifacts:',out)
