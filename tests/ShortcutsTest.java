import java.util.*;
import net.minecraft.core.registries.Registries;
import net.minecraft.world.level.levelgen.RandomState;
import net.minecraft.world.level.levelgen.structure.placement.RandomSpreadStructurePlacement;

/** The engine's two shortcuts against the game's own methods.
 *  Placement: the arithmetic position of a region's structure must be the game's, for every region-grid placement.
 *  Biomes: the cached lookup must give the game's biome, and the one-value test must never rule out the biome the
 *  game picks, at points near and far, above, at and below the surface. */
public final class ShortcutsTest {
    public static void main(String[] args) throws Exception {
        SeedEngine.initialize();
        var random=new Random(99);var placements=new IdentityHashMap<Object,String>();long compared=0;
        for(var e:SeedEngine.sets.entrySet()) {
            if(!(e.getValue().value().placement() instanceof RandomSpreadStructurePlacement p)||placements.putIfAbsent(p,e.getKey())!=null)continue;
            var grid=SeedEngine.Grid.of(p);
            if(!grid.exact())throw new AssertionError("The arithmetic placement is not in use for "+e.getKey());
            for(int i=0;i<500_000;i++,compared++) {
                long seed=random.nextLong();int reach=i%3==0?30000000/(16*p.spacing()):40,rx=random.nextInt(-reach,reach+1),rz=random.nextInt(-reach,reach+1);
                var pos=p.getLocatePos(p.getPotentialStructureChunk(seed,rx*p.spacing(),rz*p.spacing()));
                if(grid.locate(seed,rx,rz)!=((long)pos.getX()<<32|pos.getZ()&0xffffffffL))throw new AssertionError("Placement differs: "+e.getKey()+" seed="+seed+" region="+rx+","+rz);
            }
        }
        var settings=SeedEngine.generator.generatorSettings().value();var noises=SeedEngine.access.lookupOrThrow(Registries.NOISE);
        var names=new ArrayList<>(SeedEngine.biomeNames.keySet());var met=new TreeSet<String>();long points=0,spared=0,asked=0;
        BiomeGate.of("plains");
        for(int s=0;s<150;s++) {
            long seed=s==0?0:random.nextLong();var state=RandomState.create(noises,seed,settings);
            var game=SeedEngine.generator.getBiomeSource().createUncachedResolver(state);var lookup=BiomeGate.lookup(state);
            for(int k=0;k<4000;k++,points++) {
                int reach=k%5==0?7_000_000:k%5==1?200_000:6000,qx=random.nextInt(-reach,reach),qz=random.nextInt(-reach,reach);
                int qy=switch(k%4){case 0->79;case 1->random.nextInt(10,45);case 2->random.nextInt(-16,10);default->random.nextInt(-16,80);};
                var truth=game.getNoiseBiome(qx,qy,qz);String actual=truth.unwrapKey().orElseThrow().identifier().getPath();met.add(actual);
                String at=" seed="+seed+" quart="+qx+","+qy+","+qz;
                if(lookup.biome(qx,qy,qz)!=truth)throw new AssertionError("The cached lookup differs from the game:"+at);
                if(!lookup.is(actual,qx,qy,qz))throw new AssertionError("The biome the game picks was ruled out: "+actual+at);
                String other=names.get(random.nextInt(names.size()));
                if(!other.equals(actual)) { asked++;var gate=BiomeGate.of(other);if(gate!=null&&!gate.possible(lookup,qx,qy,qz))spared++;if(lookup.is(other,qx,qy,qz))throw new AssertionError("A biome the game does not pick was accepted: "+other+at); }
            }
        }
        if(met.size()<names.size()-2)throw new AssertionError("Too few biomes met to trust the run: "+met.size()+" of "+names.size());
        System.err.println("SHORTCUTS_PASS placements="+placements.size()+" positions="+compared+" biomePoints="+points+" biomesMet="+met.size()+"/"+names.size()+" lookupsSpared="+Math.round(100.0*spared/asked)+"% table: "+BiomeGate.summary);
        System.exit(0);
    }
}
