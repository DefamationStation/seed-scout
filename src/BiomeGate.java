import java.util.*;
import java.util.concurrent.*;
import net.minecraft.core.Holder;
import net.minecraft.core.QuartPos;
import net.minecraft.world.level.biome.*;
import net.minecraft.world.level.levelgen.RandomState;
import net.minecraft.world.level.levelgen.densityfunction.SamplerContext;

/** Biome lookups for the searches: the game's own, made cheaper in two ways that cannot change an answer.
 *
 * 1. The climate values are read through the game's sampler cache. A lookup reads six values that share most of
 *    their work (the same offset noise under all of them, and depth worked out from three of the others); without
 *    the cache each is computed from nothing. The cache is the one the game fills while generating a chunk.
 *
 * 2. One climate value can rule a biome out before the others are read. The game picks the biome whose box of
 *    climate ranges is nearest the sampled point. Take the entries that share one depth range (the surface ones,
 *    say) and suppose their boxes leave no gap in the other five values. Then for any sampled point the nearest of
 *    them is exactly as far as the point lies outside the whole covered range, value by value, and an entry that
 *    near must hold each value, pulled back into the covered range, inside its own range. So a biome none of whose
 *    entries holds a value that way cannot be the answer, whatever the other five values are. "No gap" is checked
 *    here against the game's own table when it is first needed, and a depth range that fails it gets no shortcut.
 */
final class BiomeGate {
    static final int TEMPERATURE=0,HUMIDITY=1,CONTINENTALNESS=2,EROSION=3,WEIRDNESS=4,VALUES=5;
    // Cheapest noise first: fewest octaves.
    static final int[] ORDER={TEMPERATURE,HUMIDITY,WEIRDNESS,EROSION,CONTINENTALNESS};

    /** A seed's climate sampler on the game's cache, with the biome source reading from it. One per worker. */
    static final class Lookup {
        final RandomState state;final SamplerContext context;final Climate.Sampler sampler;final NoiseBiomeResolver resolver;
        Lookup(RandomState state) {
            this.state=state;context=SamplerContext.builder().enableCaches().build();sampler=state.createClimateSampler(context);
            resolver=SeedEngine.generator.getBiomeSource().createResolver(sampler);
        }
        Holder<Biome> biome(int qx,int qy,int qz) { return resolver.getNoiseBiome(qx,qy,qz); }
        // The value the game's lookup reads for this quart position, in its own whole-number scale.
        long value(int which,int qx,int qy,int qz) {
            int x=QuartPos.toBlock(qx),y=QuartPos.toBlock(qy),z=QuartPos.toBlock(qz);
            return Climate.quantizeCoord(switch(which) {
                case TEMPERATURE->sampler.temperature().sampleValue(x,y,z);case HUMIDITY->sampler.humidity().sampleValue(x,y,z);
                case CONTINENTALNESS->sampler.continentalness().sampleValue(x,y,z);case EROSION->sampler.erosion().sampleValue(x,y,z);
                default->sampler.weirdness().sampleValue(x,y,z);
            });
        }
        /** Whether the biome there is the one named: the game's answer, with the lookup skipped where it cannot be. */
        boolean is(String key,int qx,int qy,int qz) {
            var gate=of(key);
            if(gate!=null&&!gate.possible(this,qx,qy,qz))return false;
            return SeedEngine.is(biome(qx,qy,qz),key);
        }
    }
    private static final ThreadLocal<Lookup> LOOKUPS=new ThreadLocal<>();
    static Lookup lookup(RandomState state) {
        var kept=LOOKUPS.get();
        if(kept==null||kept.state!=state) { if(kept!=null)kept.context.clearCaches();kept=new Lookup(state);LOOKUPS.set(kept); }
        return kept;
    }

    // One biome's entries within one depth range: for each climate value, the covered range of all entries of that
    // depth range (lo, hi) and the spans (from, to, from, to, ...) this biome's entries take in it.
    private record Group(long[] lo,long[] hi,long[][] spans) {
        boolean holds(int which,long value) {
            long v=Math.clamp(value,lo[which],hi[which]);long[] s=spans[which];
            for(int i=0;i<s.length;i+=2)if(v>=s[i]&&v<=s[i+1])return true;
            return false;
        }
    }
    private final Group[] groups;private final int[] order;
    private BiomeGate(Group[] groups,int[] order) { this.groups=groups;this.order=order; }
    /** False only where the biome cannot be the game's answer at this position. */
    boolean possible(Lookup lookup,int qx,int qy,int qz) {
        int alive=(1<<groups.length)-1;
        for(int which:order) {
            long value=lookup.value(which,qx,qy,qz);
            for(int g=0;g<groups.length;g++)if((alive&1<<g)!=0&&!groups[g].holds(which,value))alive&=~(1<<g);
            if(alive==0)return false;
        }
        return true;
    }

    private static volatile Map<String,BiomeGate> gates;
    static String summary="";
    static BiomeGate of(String key) {
        var all=gates;
        if(all==null)synchronized(BiomeGate.class) { if((all=gates)==null)gates=all=build(); }
        return all.get(key);
    }
    private static long[] range(Climate.ParameterPoint point,int which) {
        var p=switch(which){case TEMPERATURE->point.temperature();case HUMIDITY->point.humidity();case CONTINENTALNESS->point.continentalness();case EROSION->point.erosion();default->point.weirdness();};
        return new long[]{p.min(),p.max()};
    }
    @SuppressWarnings("unchecked")
    private static Map<String,BiomeGate> build() {
        var result=new HashMap<String,BiomeGate>();
        try {
            if(!(SeedEngine.generator.getBiomeSource() instanceof MultiNoiseBiomeSource source)){summary="not a climate-table biome source";return result;}
            var method=MultiNoiseBiomeSource.class.getDeclaredMethod("parameters");method.setAccessible(true);
            var list=(Climate.ParameterList<Holder<Biome>>)method.invoke(source);
            // Entries by depth range (and the entry's own fixed penalty, which the game adds to its distance).
            var byDepth=new LinkedHashMap<String,List<com.mojang.datafixers.util.Pair<Climate.ParameterPoint,Holder<Biome>>>>();
            for(var entry:list.values()) { var p=entry.getFirst();byDepth.computeIfAbsent(p.depth().min()+":"+p.depth().max()+":"+p.offset(),k->new ArrayList<>()).add(entry); }
            var perBiome=new HashMap<String,List<Group>>();var open=new HashSet<String>();var notes=new ArrayList<String>();
            for(var depth:byDepth.entrySet()) {
                var entries=depth.getValue();int n=entries.size();long[][][] boxes=new long[n][VALUES][];
                for(int i=0;i<n;i++)for(int w=0;w<VALUES;w++)boxes[i][w]=range(entries.get(i).getFirst(),w);
                boolean covered=covered(boxes);notes.add(depth.getKey()+(covered?" no gap":" has gaps")+" ("+n+")");
                long[] lo=new long[VALUES],hi=new long[VALUES];
                for(int w=0;w<VALUES;w++){lo[w]=Long.MAX_VALUE;hi[w]=Long.MIN_VALUE;for(var b:boxes){lo[w]=Math.min(lo[w],b[w][0]);hi[w]=Math.max(hi[w],b[w][1]);}}
                var mine=new HashMap<String,List<long[][]>>();
                for(int i=0;i<n;i++)mine.computeIfAbsent(entries.get(i).getSecond().unwrapKey().orElseThrow().identifier().getPath(),k->new ArrayList<>()).add(boxes[i]);
                for(var biome:mine.entrySet()) {
                    // A biome with entries in a depth range that has gaps could win there at any climate: no shortcut for it.
                    if(!covered){open.add(biome.getKey());continue;}
                    long[][] spans=new long[VALUES][];
                    for(int w=0;w<VALUES;w++) {
                        final int which=w;var sorted=biome.getValue().stream().map(b->b[which]).sorted(Comparator.comparingLong(s->s[0])).toList();var merged=new ArrayList<long[]>();
                        for(var s:sorted) { if(!merged.isEmpty()&&s[0]<=merged.getLast()[1])merged.getLast()[1]=Math.max(merged.getLast()[1],s[1]);else merged.add(s.clone()); }
                        spans[w]=merged.stream().flatMapToLong(Arrays::stream).toArray();
                    }
                    perBiome.computeIfAbsent(biome.getKey(),k->new ArrayList<>()).add(new Group(lo,hi,spans));
                }
            }
            for(var biome:perBiome.entrySet()) {
                if(open.contains(biome.getKey()))continue;
                var groups=biome.getValue().toArray(Group[]::new);
                // Only the values that can rule something out are worth reading: those some depth range does not span whole.
                int[] order=Arrays.stream(ORDER).filter(w->Arrays.stream(groups).anyMatch(g->!(g.spans[w].length==2&&g.spans[w][0]<=g.lo[w]&&g.spans[w][1]>=g.hi[w]))).toArray();
                if(order.length>0&&groups.length<=30)result.put(biome.getKey(),new BiomeGate(groups,order));
            }
            summary=String.join("; ",notes)+"; shortcuts for "+result.size()+" biomes";
        } catch(ReflectiveOperationException|RuntimeException e) { summary="unavailable: "+e;result.clear(); }
        return result;
    }
    /** Whether the boxes leave no point of their overall range uncovered, in all five values at once. Each value's
     * range is cut at every box edge into pieces no box edge falls inside (the edges themselves, and the stretches
     * between them); a box holds a piece wholly or not at all, so it is enough to try every combination of pieces. */
    private static boolean covered(long[][][] boxes) {
        int n=boxes.length,words=(n+63)/64;long[][][] holding=new long[VALUES][][];
        for(int w=0;w<VALUES;w++) {
            var edges=new TreeSet<Long>();for(var b:boxes){edges.add(b[w][0]);edges.add(b[w][1]);}
            var pieces=new ArrayList<long[]>();Long before=null;
            for(long edge:edges) { if(before!=null&&edge-before>1)pieces.add(new long[]{before+1,edge-1});pieces.add(new long[]{edge,edge});before=edge; }
            holding[w]=new long[pieces.size()][words];
            for(int p=0;p<pieces.size();p++)for(int i=0;i<n;i++)if(boxes[i][w][0]<=pieces.get(p)[0]&&pieces.get(p)[1]<=boxes[i][w][1])holding[w][p][i>>6]|=1L<<(i&63);
        }
        return covered(holding,0,null,words);
    }
    private static boolean covered(long[][][] holding,int which,long[] sofar,int words) {
        for(long[] piece:holding[which]) {
            long[] both=new long[words];boolean any=false;
            for(int i=0;i<words;i++){both[i]=sofar==null?piece[i]:sofar[i]&piece[i];any|=both[i]!=0;}
            if(!any)return false;
            if(which+1<VALUES&&!covered(holding,which+1,both,words))return false;
        }
        return true;
    }
}
