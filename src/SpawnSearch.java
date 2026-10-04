import java.util.*;
import java.util.function.*;
import net.minecraft.core.BlockPos;
import net.minecraft.world.level.ChunkPos;
import net.minecraft.world.level.biome.Climate;
import net.minecraft.world.level.levelgen.*;
import net.minecraft.world.level.levelgen.densityfunction.*;

/** Exact 26.4-alpha.2 NoiseSpawnFinder ordering, with a necessary-condition gate.
 * A null result means the vanilla winner cannot satisfy the gate, not no spawn.
 * Only the fine phase is reordered: its centre is fixed by the vanilla coarse
 * phase. Original indices preserve first-wins ties after reordering.
 */
final class SpawnSearch {
    static final int[][] COARSE = offsets(2048,512), FINE = offsets(512,32);
    private record Term(DensitySampler.Bound sampler, Climate.Parameter range) {}
    private record Point(int x,int z,long fitness,int index) {
        ChunkPos chunk() { return new ChunkPos(Math.floorDiv(x,16),Math.floorDiv(z,16)); }
    }

    static int[][] offsets(float radius,float step) {
        var points=new ArrayList<int[]>();
        // Float accumulation and integer truncation deliberately match vanilla.
        for(float angle=0,r=step;r<=radius;) {
            points.add(new int[]{(int)(Math.sin(angle)*r),(int)(Math.cos(angle)*r)});
            angle+=step/r;
            if(angle>Math.PI*2) {angle=0;r+=step;}
        }
        return points.toArray(int[][]::new);
    }

    static ChunkPos find(RandomState state,List<SpawnTargetPoint> targets,
            BiFunction<Integer,Integer,Predicate<ChunkPos>> gateFactory) {
        var context=SamplerContext.builder().enableCaches().build();
        try {
            var samplers=state.samplersWithContext(context);
            Term[][] terms=targets.stream().map(t->t.parameters().entrySet().stream()
                .map(e->new Term(samplers.get(e.getKey().value()),e.getValue()))
                .toArray(Term[]::new)).toArray(Term[][]::new);
            Point coarse=sample(terms,0,0,0);
            for(int[] offset:COARSE) {
                Point p=sample(terms,offset[0],offset[1],0);
                if(p.fitness<coarse.fitness)coarse=p;
            }
            var gate=gateFactory.apply(coarse.x,coarse.z);
            // The coarse winner remains a candidate in vanilla's fine phase.
            boolean coarseAllowed=gate.test(coarse.chunk());
            Point best=coarseAllowed?coarse:null;
            boolean[] allowed=new boolean[FINE.length];
            for(int i=0;i<FINE.length;i++) {
                int x=coarse.x+FINE[i][0],z=coarse.z+FINE[i][1];
                allowed[i]=gate.test(new ChunkPos(Math.floorDiv(x,16),Math.floorDiv(z,16)));
                if(allowed[i]) {
                    Point p=sample(terms,x,z,i+1);
                    if(best==null || wins(p,best))best=p;
                }
            }
            if(best==null || !coarseAllowed && wins(coarse,best))return null;
            for(int i=0;i<FINE.length;i++)if(!allowed[i]) {
                Point p=sample(terms,coarse.x+FINE[i][0],coarse.z+FINE[i][1],i+1);
                if(wins(p,best))return null;
            }
            return best.chunk();
        } finally { context.clearCaches(); }
    }

    private static boolean wins(Point a,Point b) {
        return a.fitness<b.fitness || a.fitness==b.fitness && a.index<b.index;
    }

    private static Point sample(Term[][] targets,int x,int z,int index) {
        int qx=Math.floorDiv(x,4)*4,qz=Math.floorDiv(z,4)*4;
        long minimum=Long.MAX_VALUE;
        for(Term[] target:targets) {
            long sum=0;
            for(Term t:target) {
                long distance=t.range.distance(Climate.quantizeCoord(t.sampler.sampleValue(qx,0,qz)));
                sum+=distance*distance;
            }
            minimum=Math.min(minimum,sum);
        }
        return new Point(x,z,minimum*(2048L*2048L)+(long)x*x+(long)z*z,index);
    }
}
