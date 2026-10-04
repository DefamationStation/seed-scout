"""Run the existing HTTP integration suite with isolated saved data and an ephemeral port."""
import pathlib,sys,threading,tempfile,unittest,shutil
ROOT=pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT));sys.path.insert(0,str(ROOT/'tests'))
import app,integration
sandbox=pathlib.Path(tempfile.mkdtemp(prefix='http-test-',dir=ROOT/'runtime/search-bench'))
(sandbox/'runtime').mkdir();shutil.copytree(ROOT/'web',sandbox/'web')
app.ROOT=sandbox;app.SAVED=sandbox/'saved-seeds.json';app.CATALOGUE=sandbox/'catalogue.db'
app.Catalogue.__init__.__defaults__=(app.CATALOGUE,)
server=app.ThreadingHTTPServer(('127.0.0.1',0),app.Handler);engine=app.Engine();server.engine=engine
worker=threading.Thread(target=server.serve_forever,daemon=True);worker.start()
try:
 assert engine.ready.wait(120),'Engine initialization timed out'
 integration.BASE='http://127.0.0.1:'+str(server.server_port)
 result=unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromModule(integration))
finally:
 server.shutdown();server.server_close();engine.close();app.TILE_POOL.shutdown()
print('Isolated artifacts:',sandbox)
raise SystemExit(0 if result.wasSuccessful() else 1)
