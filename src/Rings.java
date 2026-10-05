import java.lang.reflect.*;
import java.util.*;
import net.minecraft.core.HolderSet;
import net.minecraft.util.RandomSource;
import net.minecraft.world.level.ChunkPos;
import net.minecraft.world.level.biome.Biome;
import net.minecraft.world.level.chunk.ChunkGeneratorStructureState;
import net.minecraft.world.level.levelgen.structure.placement.ConcentricRingsStructurePlacement;

/** Strongholds stand on rings around the world origin: 128 of them, each first given a place on its ring and then
 * moved, by a biome search of up to 112 blocks, onto a biome it prefers. The game works all of them out at once,
 * which costs a biome search for each. Here the places on the rings, which are plain arithmetic on the seed, are
 * worked out for all, and the biome search, the game's own, only for the ones near enough to matter.
 */
final class Rings {
    private Rings() {}
    // The furthest the biome search can move a stronghold, in chunks, with one to spare for rounding.
    static final int MOVE=8;
    private record Slot(int x,int z,RandomSource random) {}
    private static final class Ring { Slot[] slots;ChunkPos[] moved; }
    private static final Map<ChunkGeneratorStructureState,Map<ConcentricRingsStructurePlacement,Ring>> KEPT=Collections.synchronizedMap(new WeakHashMap<>());
    private static Field seedField;private static Method move;

    private static Ring ring(ChunkGeneratorStructureState state,ConcentricRingsStructurePlacement placement) {
        return KEPT.computeIfAbsent(state,s->Collections.synchronizedMap(new HashMap<>())).computeIfAbsent(placement,p->{
            try {
                if(seedField==null){var f=ChunkGeneratorStructureState.class.getDeclaredField("concentricRingsSeed");f.setAccessible(true);seedField=f;}
                // The same steps as ChunkGeneratorStructureState.generateRingPositions, without the biome search.
                int distance=p.distance(),count=p.count(),spread=p.spread();var ring=new Ring();ring.slots=new Slot[count];ring.moved=new ChunkPos[count];
                var random=RandomSource.create();random.setSeed(seedField.getLong(state));
                double angle=random.nextDouble()*Math.PI*2;int inRing=0,index=0;
                for(int i=0;i<count;i++) {
                    double far=4*distance+distance*index*6+(random.nextDouble()-.5)*(distance*2.5);
                    ring.slots[i]=new Slot((int)Math.round(Math.cos(angle)*far),(int)Math.round(Math.sin(angle)*far),random.fork());
                    angle+=Math.PI*2/spread;
                    if(++inRing==spread){index++;inRing=0;spread+=2*spread/(index+1);spread=Math.min(spread,count-i);angle+=random.nextDouble()*Math.PI*2;}
                }
                return ring;
            } catch(ReflectiveOperationException e) { throw new IllegalStateException(e); }
        });
    }
    // The game's own biome search for one stronghold, run once and kept.
    private static ChunkPos moved(ChunkGeneratorStructureState state,ConcentricRingsStructurePlacement placement,Ring ring,int i) {
        synchronized(ring) {
            if(ring.moved[i]!=null)return ring.moved[i];
            try {
                if(move==null){var m=ChunkGeneratorStructureState.class.getDeclaredMethod("lambda$generateRingPositions$0",int.class,int.class,HolderSet.class,RandomSource.class);m.setAccessible(true);move=m;}
                return ring.moved[i]=(ChunkPos)move.invoke(state,ring.slots[i].x,ring.slots[i].z,placement.preferredBiomes(),ring.slots[i].random);
            } catch(ReflectiveOperationException e) { throw new IllegalStateException(e); }
        }
    }
    /** The strongholds whose chunk could lie in the rectangle of chunks, each at its final place. */
    static List<ChunkPos> within(ChunkGeneratorStructureState state,ConcentricRingsStructurePlacement placement,int minX,int maxX,int minZ,int maxZ) {
        var ring=ring(state,placement);var found=new ArrayList<ChunkPos>();
        for(int i=0;i<ring.slots.length;i++) {
            var slot=ring.slots[i];
            if(slot.x<minX-MOVE||slot.x>maxX+MOVE||slot.z<minZ-MOVE||slot.z>maxZ+MOVE)continue;
            var pos=moved(state,placement,ring,i);
            if(pos.x()>=minX&&pos.x()<=maxX&&pos.z()>=minZ&&pos.z()<=maxZ)found.add(pos);
        }
        return found;
    }
    static boolean at(ChunkGeneratorStructureState state,ConcentricRingsStructurePlacement placement,ChunkPos chunk) {
        return within(state,placement,chunk.x(),chunk.x(),chunk.z(),chunk.z()).contains(chunk);
    }
}
