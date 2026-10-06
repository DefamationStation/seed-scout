import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;
import com.google.gson.*;
import net.minecraft.world.level.levelgen.RandomState;
import net.minecraft.core.registries.Registries;

/** Differential oracle: installed Minecraft spawn search, not another copy of our search. */
public class SpawnSearchTest {
 public static void main(String[] args)throws Exception {
  SeedEngine.initialize();var targets=SeedEngine.generator.generatorSettings().value().spawnTarget();
  var pool=Executors.newFixedThreadPool(4);var futures=new ArrayList<Future<?>>();var checked=new AtomicInteger();var accepted=new AtomicInteger();
  for(int worker=0;worker<4;worker++){final int w=worker;futures.add(pool.submit(()->{
   var random=new Random(7400+w);
   for(int i=0;i<3000;i++){
    long seed=switch(i%4){case 0->-3811937398911544709L+i*4+w;case 1->i*4L+w;case 2->Long.MIN_VALUE+i*4L+w;default->random.nextLong();};
    var state=RandomState.create(SeedEngine.access.lookupOrThrow(Registries.NOISE),seed,SeedEngine.generator.generatorSettings().value());
    var expected=SeedEngine.generator.getOrigin(state);
    int radius=switch(i%5){case 0->0;case 1->16;case 2->100;default->256;};
    String key=i%3==0?"ocean_monuments":"woodland_mansions";
    var feature=new SeedEngine.Feature("structure",key,radius,i%7==0?radius/2:0,i%11==0?2:1,false,null,null,List.of(),List.of(),List.of(),List.of());
    var actual=SpawnSearch.find(state,targets,(x,z)->SeedEngine.placementGate(feature,seed,x,z));
    boolean possible=SeedEngine.placementGate(feature,seed,expected.getMiddleBlockX(),expected.getMiddleBlockZ()).test(expected);
    if(possible ? !expected.equals(actual) : actual!=null)throw new AssertionError("Mismatch seed="+seed+" feature="+feature+" expected="+expected+" possible="+possible+" actual="+actual);
    if(actual!=null)accepted.incrementAndGet();checked.incrementAndGet();
    if(i%20==0){var all=SpawnSearch.find(state,targets,(x,z)->chunk->true);if(!expected.equals(all))throw new AssertionError("Unfiltered mismatch "+seed);checked.incrementAndGet();}
   }
  }));}
  for(var f:futures)f.get();pool.shutdown();
  System.err.println("SPAWN_SEARCH_PASS comparisons="+checked+" accepted="+accepted);System.exit(0);
 }
}
