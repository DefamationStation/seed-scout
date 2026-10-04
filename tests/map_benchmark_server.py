"""Isolated manual browser benchmark server. Never use production saves or expose publicly."""
import pathlib,sys,tempfile,shutil,argparse
root=pathlib.Path(__file__).resolve().parents[1]
p=argparse.ArgumentParser();p.add_argument('--baseline-map',required=True);p.add_argument('--port',type=int,default=8880);args=p.parse_args()
sys.path.insert(0,str(root))
import app
(root/'runtime/map-bench').mkdir(parents=True,exist_ok=True)
sandbox=pathlib.Path(tempfile.mkdtemp(prefix='http-',dir=root/'runtime/map-bench'));(sandbox/'runtime').mkdir();shutil.copytree(root/'web',sandbox/'web')
app.ROOT=app.DATA=sandbox;app.SAVED=sandbox/'saved-seeds.json';app.CATALOGUE=sandbox/'catalogue.db';app.Catalogue.__init__.__defaults__=(app.CATALOGUE,)
shutil.copyfile(pathlib.Path(args.baseline_map),sandbox/'web/baseline-map.js')
(sandbox/'web/baseline.html').write_text((sandbox/'web/index.html').read_text(encoding='utf-8').replace('/map.js','/baseline-map.js'),encoding='utf-8')
class BenchHandler(app.Handler):
 def do_POST(self):
  if self.path=='/bench/reset' and self.trusted():
   self.rfile.read(int(self.headers.get('Content-Length',0)))
   with self.server.engine.lock:self.server.engine.tiles.clear();self.server.engine.structure_tiles.clear()
   return self.reply({'ok':True})
  return super().do_POST()
server=app.ThreadingHTTPServer(('127.0.0.1',args.port),BenchHandler);server.engine=app.Engine()
print('Sandbox',sandbox,flush=True)
try:server.serve_forever()
finally:server.server_close();server.engine.close();app.TILE_POOL.shutdown()

