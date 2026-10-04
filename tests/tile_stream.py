"""Streaming protocol tests, including a slow first tile and a per-tile failure."""
import pathlib,sys,threading,json,urllib.request,unittest
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[1]))
import app
class StreamingTests(unittest.TestCase):
 def setUp(self):
  self.release=threading.Event();outer=self
  class Engine:
   tile_places=staticmethod(app.Engine.tile_places)
   def tile(self,r):
    if r['x']==0:
     if not outer.release.wait(5):raise RuntimeError('test timeout')
    if r['x']==2:raise ValueError('test tile failure')
    return dict(x=r['x'],z=r['z'])
  self.server=app.ThreadingHTTPServer(('127.0.0.1',0),app.Handler);self.server.engine=Engine()
  threading.Thread(target=self.server.serve_forever,daemon=True).start()
  self.url=f'http://127.0.0.1:{self.server.server_port}/api/tile-stream?seed=123&step=8&mode=terrain&at='
 def tearDown(self):
  self.release.set();self.server.shutdown();self.server.server_close()
 def test_fast_tiles_arrive_before_slow_first_tile(self):
  with urllib.request.urlopen(self.url+'0,0;1,0',timeout=3) as r:
   first=json.loads(r.readline());self.assertEqual(first,dict(index=1,tile=dict(x=1,z=0)))
   self.release.set();last=json.loads(r.readline());self.assertEqual(last['index'],0);self.assertEqual(r.readline(),b'')
 def test_error_does_not_drop_good_tiles(self):
  with urllib.request.urlopen(self.url+'1,0;2,0',timeout=3) as r:rows=[json.loads(line) for line in r]
  records={row['index']:row for row in rows};self.assertIn('tile',records[0]);self.assertEqual(records[1]['error'],'test tile failure')
 def test_invalid_batch_rejected_before_stream_headers(self):
  with self.assertRaises(urllib.error.HTTPError) as e:urllib.request.urlopen(self.url+'1',timeout=3)
  self.assertEqual(e.exception.code,400)
if __name__=='__main__':unittest.main()
