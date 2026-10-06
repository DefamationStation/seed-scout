import com.google.gson.*;
import java.util.*;
import java.util.function.BooleanSupplier;
import net.minecraft.core.QuartPos;
import net.minecraft.world.level.levelgen.RandomState;

/** Conditions on the shape of the land around a point: how much of it is one biome, how level it is, whether
 * there is high ground in reach, whether a river runs by, and whether a river closes round an island. They cost far more than a structure or biome check
 * (hundreds of terrain columns), so they are tested last, on places that already hold every other condition.
 * Each one reports what it measured and a score from 0 to 1, so results can be ranked by how well they fit.
 */
final class Landscape {
    private Landscape() {}

    /** Every landscape condition around (x, z), or the match a condition names in "from". Null when one fails. */
    static List<Map<String,Object>> check(JsonArray specs,RandomState state,int x,int z,List<Map<String,Object>> found,BooleanSupplier running) {
        var out=new ArrayList<Map<String,Object>>();
        // Biome and river conditions read the cheap biome estimate; they go first so the terrain ones run less often.
        var order=new ArrayList<JsonObject>();
        for(var item:specs)order.add(item.getAsJsonObject());
        order.sort(Comparator.comparingInt(s->switch(s.get("type").getAsString()){case "coverage"->0;case "river","island"->1;default->2;}));
        for(var spec:order) {
            if(!running.getAsBoolean())return null;
            int ox=x,oz=z;
            if(spec.has("from")&&!spec.get("from").getAsString().isEmpty()) {
                // Measured from the reported match of another condition, in the Overworld.
                String from=spec.get("from").getAsString();
                var parent=found.stream().filter(m->from.equals(m.get("key"))&&!m.containsKey("dimension")).findFirst().orElse(null);
                if(parent==null)return null;
                ox=((Number)parent.get("x")).intValue();oz=((Number)parent.get("z")).intValue();
            }
            var match=switch(spec.get("type").getAsString()) {
                case "coverage"->coverage(spec,state,ox,oz);
                case "flat"->flat(spec,state,ox,oz);
                case "hill"->hill(spec,state,ox,oz);
                case "river"->river(spec,state,ox,oz);
                case "island"->island(spec,state,ox,oz);
                default->throw new IllegalArgumentException("Unknown landscape condition: "+spec.get("type").getAsString());
            };
            if(match==null)return null;
            match.put("kind","terrain");match.put("key",spec.get("type").getAsString());match.put("index",spec.get("index").getAsInt());
            match.putIfAbsent("x",ox);match.putIfAbsent("z",oz);match.putIfAbsent("distance",0);
            if(ox!=x||oz!=z)match.put("from",spec.get("from").getAsString());
            out.add(match);
        }
        out.sort(Comparator.comparingInt(m->(Integer)m.get("index")));
        return out;
    }

    // The surface biome as the wide map views read it: the noise biome well above the router's surface estimate.
    // No terrain column is computed, which makes it about a hundred times cheaper than the exact biome.
    private static String biome(RandomState state,net.minecraft.world.level.biome.NoiseBiomeResolver resolver,int bx,int bz) {
        var surface=SeedEngine.generator.generatorSettings().value().noiseRouter().chunkSurfaceLevel();
        int estimate=Math.round(state.sampleBlockValueUncached(surface,bx,0,bz))+12;
        return resolver.getNoiseBiome(QuartPos.fromBlock(bx),QuartPos.fromBlock(estimate+64),QuartPos.fromBlock(bz)).unwrapKey().orElseThrow().identifier().getPath();
    }
    private static SeedEngine.Surface column(RandomState state,int bx,int bz) {
        var noise=SeedEngine.generator.generatorSettings().value().noiseSettings().clampToHeightAccessor(SeedEngine.heights);
        return SeedEngine.surface(state,noise,bx,bz);
    }
    // A grid step that puts about `wanted` samples in a disc of this radius, never finer than `least` blocks.
    private static int step(int radius,int wanted,int least) { return Math.max(least,(int)Math.round(radius*Math.sqrt(Math.PI/wanted)/4)*4); }

    /** At least (or at most) a share of the land within the radius is one of the given biomes. */
    static Map<String,Object> coverage(JsonObject spec,RandomState state,int x,int z) {
        int radius=spec.get("radius").getAsInt(),step=step(radius,900,4);var wanted=new HashSet<String>();
        for(var b:spec.getAsJsonArray("biomes"))wanted.add(b.getAsString());
        var resolver=SeedEngine.generator.getBiomeSource().createUncachedResolver(state);
        int total=0,inside=0;
        for(int dx=-radius;dx<=radius;dx+=step)for(int dz=-radius;dz<=radius;dz+=step) {
            if(dx*dx+dz*dz>radius*radius)continue;
            total++;if(wanted.contains(biome(state,resolver,x+dx,z+dz)))inside++;
        }
        double share=total==0?0:(double)inside/total,limit=spec.get("share").getAsDouble()/100;
        boolean most=spec.has("mode")&&spec.get("mode").getAsString().equals("max");
        if(most?share>limit:share<limit)return null;
        return new LinkedHashMap<>(Map.of("share",Math.round(share*100),"score",most?1-share:share,"area",true,"biomes",wanted.stream().sorted().toList()));
    }

    /** A share of the ground within the radius lies within a few blocks of its typical height. Water does not count as level ground. */
    static Map<String,Object> flat(JsonObject spec,RandomState state,int x,int z) {
        int radius=spec.get("radius").getAsInt(),tolerance=spec.get("tolerance").getAsInt(),step=step(radius,500,4);
        var land=new ArrayList<Integer>();int total=0;
        for(int dx=-radius;dx<=radius;dx+=step)for(int dz=-radius;dz<=radius;dz+=step) {
            if(dx*dx+dz*dz>radius*radius)continue;
            total++;var c=column(state,x+dx,z+dz);
            if(!c.water())land.add(c.ground());
        }
        double limit=spec.get("share").getAsDouble()/100;
        // Not enough land for the share to be reachable at all.
        if(total==0||land.size()<limit*total)return null;
        Collections.sort(land);
        // The best level: the height whose band holds the most ground. The heights are sorted, so one pass finds it.
        int best=0,level=land.get(land.size()/2);
        for(int low=0,high=0;low<land.size();low++) {
            while(high<land.size()&&land.get(high)-land.get(low)<=2*tolerance)high++;
            if(high-low>best){best=high-low;level=land.get(low)+tolerance;}
        }
        double share=(double)best/total;
        if(share<limit)return null;
        return new LinkedHashMap<>(Map.of("share",Math.round(share*100),"level",level,"y",level,"score",share,"area",true));
    }

    /** Ground that stands well above the starting point, far enough away and wide enough to build on. */
    static Map<String,Object> hill(JsonObject spec,RandomState state,int x,int z) {
        int radius=spec.get("radius").getAsInt(),inner=spec.get("minRadius").getAsInt(),rise=spec.get("rise").getAsInt(),across=spec.has("across")?spec.get("across").getAsInt():0;
        boolean absolute=spec.has("measure")&&spec.get("measure").getAsString().equals("y");
        // The starting level: the middle ground height of five columns at the origin, or sea level when all are water.
        var base=new ArrayList<Integer>();
        for(int[] at:new int[][]{{0,0},{12,0},{-12,0},{0,12},{0,-12}}){var c=column(state,x+at[0],z+at[1]);if(!c.water())base.add(c.ground());}
        Collections.sort(base);int ground=base.isEmpty()?SeedEngine.generator.getSeaLevel():base.get(base.size()/2),needed=absolute?rise:ground+rise;
        int step=step(radius,600,8),high=0,peak=Integer.MIN_VALUE,px=x,pz=z;
        for(int dx=-radius;dx<=radius;dx+=step)for(int dz=-radius;dz<=radius;dz+=step) {
            int d2=dx*dx+dz*dz;
            if(d2>radius*radius||d2<inner*inner)continue;
            var c=column(state,x+dx,z+dz);
            if(c.water())continue;
            if(c.ground()>=needed)high++;
            if(c.ground()>peak){peak=c.ground();px=x+dx;pz=z+dz;}
        }
        int width=(int)Math.round(Math.sqrt((double)high*step*step));
        if(high==0||width<across)return null;
        var match=new LinkedHashMap<String,Object>(Map.of("x",px,"y",peak,"z",pz,"distance",Math.round(Math.hypot(px-x,pz-z)),"rise",peak-ground,"across",width,"level",ground));
        match.put("score",Math.min(1,(peak-ground)/80.0));
        return match;
    }

    /** A river passing close by: long enough, wide enough and as straight as asked. */
    static Map<String,Object> river(JsonObject spec,RandomState state,int x,int z) {
        int within=spec.get("within").getAsInt(),length=spec.get("length").getAsInt(),width=spec.has("width")?spec.get("width").getAsInt():0;
        String shape=spec.has("shape")?spec.get("shape").getAsString():"any";
        // The river has to come within reach and can run on for its length from there, so that is how far to look.
        int radius=within+length,step=Math.clamp(Math.round(radius/50f/4)*4,4,32),size=2*(radius/step)+1,half=radius/step;
        var resolver=SeedEngine.generator.getBiomeSource().createUncachedResolver(state);
        var water=new boolean[size*size];boolean any=false;
        for(int gx=0;gx<size;gx++)for(int gz=0;gz<size;gz++) {
            int dx=(gx-half)*step,dz=(gz-half)*step;
            if(dx*dx+dz*dz>radius*radius)continue;
            String name=biome(state,resolver,x+dx,z+dz);
            if(name.equals("river")||name.equals("frozen_river")){water[gx*size+gz]=true;any=true;}
        }
        if(!any)return null;
        // Each connected stretch of river is judged on its own, so two rivers are not read as one crooked one.
        var seen=new boolean[size*size];Map<String,Object> best=null;double bestScore=-1;
        for(int start=0;start<water.length;start++) {
            if(!water[start]||seen[start])continue;
            var cells=new ArrayList<Integer>();var queue=new ArrayDeque<Integer>();queue.add(start);seen[start]=true;
            while(!queue.isEmpty()) {
                int cell=queue.poll();cells.add(cell);int cx=cell/size,cz=cell%size;
                for(int ax=-1;ax<=1;ax++)for(int az=-1;az<=1;az++) {
                    int nx=cx+ax,nz=cz+az,next=nx*size+nz;
                    if(nx<0||nz<0||nx>=size||nz>=size||!water[next]||seen[next])continue;
                    seen[next]=true;queue.add(next);
                }
            }
            // Its line: the direction the cells spread furthest along, and how far they stray to its sides.
            double mx=0,mz=0,near=Double.MAX_VALUE;int nx=0,nz=0;
            for(int cell:cells){int dx=(cell/size-half)*step,dz=(cell%size-half)*step;mx+=dx;mz+=dz;double d=Math.hypot(dx,dz);if(d<near){near=d;nx=dx;nz=dz;}}
            if(near>within)continue;
            mx/=cells.size();mz/=cells.size();double sxx=0,szz=0,sxz=0;
            for(int cell:cells){double dx=(cell/size-half)*step-mx,dz=(cell%size-half)*step-mz;sxx+=dx*dx;szz+=dz*dz;sxz+=dx*dz;}
            double angle=.5*Math.atan2(2*sxz,sxx-szz),ux=Math.cos(angle),uz=Math.sin(angle),low=Double.MAX_VALUE,high=-Double.MAX_VALUE,stray=0;
            for(int cell:cells){double dx=(cell/size-half)*step-mx,dz=(cell%size-half)*step-mz,along=dx*ux+dz*uz,side=-dx*uz+dz*ux;low=Math.min(low,along);high=Math.max(high,along);stray+=side*side;}
            double run=high-low+step,band=cells.size()*(double)step*step/run,wander=Math.sqrt(stray/cells.size())/run;
            // A straight river of this width strays by width / sqrt(12); what is left over is its bends.
            double bends=Math.max(0,wander-band/Math.sqrt(12)/run);
            if(run<length||shape.equals("fairly")&&bends>.12||shape.equals("very")&&bends>.05)continue;
            // The river biome is a band wider than its water. The width is the water itself: from a water column
            // where the river comes nearest, the shortest of the four straight lines across it.
            int wx=x+nx,wz=z+nz;boolean wet=column(state,wx,wz).water();
            for(int r=4;r<=24&&!wet;r+=4)for(int[] at:new int[][]{{r,0},{-r,0},{0,r},{0,-r},{r,r},{-r,-r},{r,-r},{-r,r}})
                if(!wet&&column(state,x+nx+at[0],z+nz+at[1]).water()){wet=true;wx=x+nx+at[0];wz=z+nz+at[1];}
            int wide=wet?Integer.MAX_VALUE:0;
            if(wet)for(int[] dir:new int[][]{{1,0},{0,1},{1,1},{1,-1}}) {
                int count=1;
                for(int sign=-1;sign<=1;sign+=2)for(int t=1;t<=64;t++){if(!column(state,wx+sign*t*dir[0],wz+sign*t*dir[1]).water())break;count++;}
                wide=Math.min(wide,(int)Math.round(count*Math.hypot(dir[0],dir[1])));
            }
            if(wide<width)continue;
            double score=.5*Math.max(0,1-bends/.2)+.5*Math.min(1,run/(2.0*radius));
            if(score>bestScore) {
                bestScore=score;
                best=new LinkedHashMap<>(Map.of("x",x+nx,"y",SeedEngine.generator.getSeaLevel(),"z",z+nz,"distance",Math.round(near),"length",Math.round(run),"width",wide,"shape",bends<=.05?"straight":bends<=.12?"fairly straight":"winding","score",score));
            }
        }
        return best;
    }

    /** Land that a river closes right round: an island of the size asked for, within reach, standing in water.
     * The river biome is read every 8 blocks around the point. Land that cannot be left without crossing river is
     * an island; a step across a corner between two river cells counts as leaving, so the ring has no thin places.
     * Water is then looked for on the real terrain along twelve lines out from the island's middle, because the
     * river biome is a band wider than its water and, in high country, can be a dry valley. */
    static Map<String,Object> island(JsonObject spec,RandomState state,int x,int z) {
        int within=spec.get("within").getAsInt(),least=spec.get("minAcross").getAsInt(),most=spec.get("maxAcross").getAsInt();
        boolean own=spec.has("own")&&spec.get("own").getAsBoolean();var wanted=new HashSet<String>();
        if(spec.has("biomes"))for(var b:spec.getAsJsonArray("biomes"))wanted.add(b.getAsString());
        final int step=8,radius=within+most/2+96,half=radius/step,size=2*half+1,high=SeedEngine.ABOVE_SURFACE;
        var lookup=BiomeGate.lookup(state);
        var river=new boolean[size*size];boolean any=false;
        for(int gx=0;gx<size;gx++)for(int gz=0;gz<size;gz++) {
            int qx=QuartPos.fromBlock(x+(gx-half)*step),qz=QuartPos.fromBlock(z+(gz-half)*step);
            if(lookup.is("river",qx,high,qz)||lookup.is("frozen_river",qx,high,qz)){river[gx*size+gz]=true;any=true;}
        }
        if(!any)return null;
        // Everything that can be reached from the edge of the area without crossing river is not an island.
        var open=new boolean[size*size];var queue=new ArrayDeque<Integer>();
        for(int i=0;i<size;i++)for(int cell:new int[]{i,(size-1)*size+i,i*size,i*size+size-1})if(!river[cell]&&!open[cell]){open[cell]=true;queue.add(cell);}
        while(!queue.isEmpty()) {
            int cell=queue.poll(),cx=cell/size,cz=cell%size;
            for(int ax=-1;ax<=1;ax++)for(int az=-1;az<=1;az++) {
                int nx=cx+ax,nz=cz+az,next=nx*size+nz;
                if(nx<0||nz<0||nx>=size||nz>=size||river[next]||open[next])continue;
                open[next]=true;queue.add(next);
            }
        }
        var island=new int[size*size];int islands=0;Map<String,Object> best=null;double bestScore=-1;
        for(int start=0;start<island.length;start++) {
            if(river[start]||open[start]||island[start]!=0)continue;
            int id=++islands;var cells=new ArrayList<Integer>();queue.add(start);island[start]=id;
            while(!queue.isEmpty()) {
                int cell=queue.poll();cells.add(cell);int cx=cell/size,cz=cell%size;
                for(int ax=-1;ax<=1;ax++)for(int az=-1;az<=1;az++) {
                    int nx=cx+ax,nz=cz+az,next=nx*size+nz;
                    if(nx<0||nz<0||nx>=size||nz>=size||river[next]||open[next]||island[next]!=0)continue;
                    island[next]=id;queue.add(next);
                }
            }
            // As wide as a circle of the same area.
            int across=(int)Math.round(2*Math.sqrt(cells.size()*(double)step*step/Math.PI));
            if(across<least||across>most)continue;
            double mx=0,mz=0;for(int cell:cells){mx+=cell/size;mz+=cell%size;}
            int cx=(int)Math.round(mx/cells.size()),cz=(int)Math.round(mz/cells.size()),ix=x+(cx-half)*step,iz=z+(cz-half)*step;
            double distance=Math.hypot(ix-x,iz-z);
            if(distance>within)continue;
            // Its biome: the commonest on it (every cell of a small island, a spread of 400 of a large one).
            var on=new HashMap<String,Integer>();int every=Math.max(1,cells.size()/400),read=0;
            for(int i=0;i<cells.size();i+=every,read++){int cell=cells.get(i);on.merge(name(lookup,x+(cell/size-half)*step,z+(cell%size-half)*step),1,Integer::sum);}
            String biome=Collections.max(on.entrySet(),Map.Entry.comparingByValue()).getKey();
            if(biome.contains("ocean")||!wanted.isEmpty()&&!wanted.contains(biome))continue;
            // The banks: the land met first across the river, in every direction the river is followed from the island.
            var ring=new HashSet<Integer>();var banks=new LinkedHashSet<Integer>();var frontier=new ArrayDeque<int[]>();
            for(int cell:cells)frontier.add(new int[]{cell,0});
            while(!frontier.isEmpty()) {
                var at=frontier.poll();int ax0=at[0]/size,az0=at[0]%size;
                for(int ax=-1;ax<=1;ax++)for(int az=-1;az<=1;az++) {
                    int nx=ax0+ax,nz=az0+az,next=nx*size+nz;
                    if(nx<0||nz<0||nx>=size||nz>=size||island[next]==id)continue;
                    if(!river[next]){if(at[1]>0)banks.add(next);continue;}
                    if(at[1]<16&&ring.add(next))frontier.add(new int[]{next,at[1]+1});
                }
            }
            var beyond=new HashMap<String,Integer>();every=Math.max(1,banks.size()/300);int i=0;
            for(int cell:banks)if(i++%every==0)beyond.merge(name(lookup,x+(cell/size-half)*step,z+(cell%size-half)*step),1,Integer::sum);
            boolean distinct=!beyond.containsKey(biome);
            if(own&&!distinct)continue;
            // Water on the way out, in twelve directions: the first water column met in the river counts.
            int wet=0;
            for(int side=0;side<12;side++) {
                double ux=Math.cos(side*Math.PI/6),uz=Math.sin(side*Math.PI/6);boolean reached=false;
                for(int t=0;t<2*size;t++) {
                    int gx=(int)Math.round(cx+ux*t),gz=(int)Math.round(cz+uz*t);
                    if(gx<0||gz<0||gx>=size||gz>=size)break;
                    int cell=gx*size+gz;
                    if(island[cell]==id){if(reached)break;continue;}
                    if(!river[cell])break;
                    reached=true;
                    if(column(state,x+(gx-half)*step,z+(gz-half)*step).water()){wet++;break;}
                }
            }
            if(wet<9)continue;
            double share=(double)on.get(biome)/read,score=.5*wet/12+.3*(distinct?1:0)+.2*share;
            if(score>bestScore||score==bestScore&&best!=null&&distance<((Number)best.get("distance")).doubleValue()) {
                bestScore=score;
                best=new LinkedHashMap<>(Map.of("x",ix,"y",SeedEngine.generator.getSeaLevel(),"z",iz,"distance",Math.round(distance),"across",across,"biome",biome,"share",Math.round(share*100),"sides",wet,"own",distinct,"score",score));
                best.put("around",beyond.entrySet().stream().sorted(Map.Entry.<String,Integer>comparingByValue().reversed()).limit(3).map(Map.Entry::getKey).toList());
            }
        }
        return best;
    }
    private static String name(BiomeGate.Lookup lookup,int bx,int bz) {
        return lookup.biome(QuartPos.fromBlock(bx),SeedEngine.ABOVE_SURFACE,QuartPos.fromBlock(bz)).unwrapKey().orElseThrow().identifier().getPath();
    }
}
