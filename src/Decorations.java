import java.lang.reflect.*;
import java.util.*;
import net.minecraft.core.*;
import net.minecraft.core.registries.Registries;
import net.minecraft.resources.Identifier;
import net.minecraft.world.level.ChunkPos;
import net.minecraft.world.level.WorldGenLevel;
import net.minecraft.world.level.chunk.CarvingMask;
import net.minecraft.world.level.biome.*;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.levelgen.*;
import net.minecraft.world.level.levelgen.densityfunction.DensityVolume;
import net.minecraft.world.level.levelgen.placement.FeaturePlacer;
import net.minecraft.world.level.levelgen.placement.PlacedFeature;

/** Dungeons and amethyst geodes. They are not structures: the game places them while decorating each chunk, with
 * a random sequence seeded from the world seed and the chunk, and decides on the spot from the blocks it finds.
 * This runs the game's own placement and feature code for a chunk against the terrain computed here: the noise
 * terrain with its aquifers, and the caves and ravines the carvers cut. What the game adds after that is not
 * known (lakes, structures, the features placed before these), so a find is a prediction.
 * Checked against a saved world of this version: 86% of its dungeons were found, at the exact block, and 94% of
 * the dungeons predicted were there; every geode was found, and about 7 in 10 of the geodes predicted were there.
 */
final class Decorations {
    private Decorations() {}
    record Find(String key,int x,int y,int z) {}
    /** Search keys and the placed features behind them, in the order the game places them. */
    static final Map<String,List<String>> KEYS=Map.of("dungeons",List.of("monster_room","monster_room_deep"),"amethyst_geodes",List.of("amethyst_geode"));
    private record Placed(String key,PlacedFeature feature,int step,int index) {}
    private static List<Placed> placed;
    static boolean handles(String key) { return KEYS.containsKey(key); }

    private static synchronized List<Placed> placed() {
        if(placed!=null)return placed;
        var source=SeedEngine.generator.getBiomeSource();
        var steps=FeatureSorter.buildFeaturesPerStep(List.copyOf(source.possibleBiomes()),biome->biome.value().getGenerationSettings().features(),true);
        var registry=SeedEngine.access.lookupOrThrow(Registries.PLACED_FEATURE);var list=new ArrayList<Placed>();
        KEYS.forEach((key,names)->{for(String name:names) {
            var feature=registry.getValue(Identifier.withDefaultNamespace(name));
            if(feature==null)throw new IllegalStateException("This Minecraft version has no "+name);
            for(int step=0;step<steps.size();step++)if(steps.get(step).features().contains(feature))list.add(new Placed(key,feature,step,steps.get(step).indexMapping().applyAsInt(feature)));
        }});
        list.sort(Comparator.comparingInt(Placed::step).thenComparingInt(Placed::index));
        return placed=list;
    }

    // The base terrain of one chunk, bottom to top for each column. Kept per thread, as a search asks for neighbours.
    private static final ThreadLocal<Map<Long,BlockState[]>> TERRAIN=ThreadLocal.withInitial(()->new LinkedHashMap<>(64,.75f,true){protected boolean removeEldestEntry(Map.Entry<Long,BlockState[]> e){return size()>48;}});
    private static final ThreadLocal<long[]> TERRAIN_SEED=ThreadLocal.withInitial(()->new long[]{Long.MIN_VALUE});
    static BlockState[] terrain(long seed,RandomState state,int cx,int cz) {
        var cache=TERRAIN.get();
        if(TERRAIN_SEED.get()[0]!=seed){cache.clear();TERRAIN_SEED.get()[0]=seed;}
        return cache.computeIfAbsent(((long)cx<<32)|(cz&0xffffffffL),key->{
            int minY=SeedEngine.heights.getMinY(),height=SeedEngine.heights.getHeight();var blocks=new BlockState[256*height];
            // The column marks solid ground with a placeholder; the world's default block stands in for it.
            var stone=Blocks.STONE.defaultBlockState();
            var mask=carvingMask(state,cx,cz);
            try(var chunk=SeedEngine.noiseChunk(state,new DensityVolume(16,height,16,cx<<4,minY,cz<<4),true)) {
                var aquifer=chunk.aquifer();
                for(int z=0;z<16;z++)for(int x=0;x<16;x++) {
                    var column=chunk.prepareColumn(x,z);var carved=mask.isEmpty()?null:mask.getColumn(x,z);
                    for(int i=0;i<height;i++){var block=column.getBlockForIndex(i);
                        // Where a cave or ravine is carved through solid ground the game puts what the aquifer has there: air, water or lava.
                        if(block==NoiseColumn.SOLID&&carved!=null&&carved.isCarved(minY+i))block=aquifer.computeSubstance((cx<<4)+x,minY+i,(cz<<4)+z,0);
                        blocks[(z*16+x)*height+i]=block==NoiseColumn.SOLID?stone:block;
                    }
                }
            }
            return blocks;
        });
    }

    // The caves and ravines carved through a chunk, as the generator works them out: every carver of the biomes
    // within eight chunks is seeded from the world seed and its own chunk, and marks what it cuts out of this one.
    private static Method carverBiome;
    static CarvingMask carvingMask(RandomState state,int cx,int cz) {
        try {
            if(carverBiome==null){var m=NoiseBasedChunkGenerator.class.getDeclaredMethod("getBiomeGenerationSettingsForCarver",NoiseBiomeResolver.class,ChunkPos.class);m.setAccessible(true);carverBiome=m;}
            var context=VerticalAnchor.Context.from(SeedEngine.generator,SeedEngine.heights);
            var mask=new CarvingMask(context.minY()+1,context.maxY()-7);
            var random=new WorldgenRandom(new LegacyRandomSource(0));var resolver=SeedEngine.generator.getBiomeSource().createUncachedResolver(state);var target=new ChunkPos(cx,cz);
            for(int dx=-8;dx<=8;dx++)for(int dz=-8;dz<=8;dz++) {
                var source=new ChunkPos(cx+dx,cz+dz);int index=0;
                for(var carver:((BiomeGenerationSettings)carverBiome.invoke(SeedEngine.generator,resolver,source)).getCarvers()) {
                    random.setLargeFeatureSeed(state.seed()+index++,source.x(),source.z());
                    if(carver.value().isStartChunk(random))carver.value().carve(context,random,target,source,mask);
                }
            }
            return mask;
        } catch(ReflectiveOperationException e) { throw new IllegalStateException(e); }
    }

    // What a chunk holds, kept per thread: a search asks again for the same chunks when it confirms a match.
    private static final ThreadLocal<Map<String,List<Find>>> FOUND=ThreadLocal.withInitial(()->new LinkedHashMap<>(256,.75f,true){protected boolean removeEldestEntry(Map.Entry<String,List<Find>> e){return size()>4096;}});
    // A geode is tried in one chunk in 24, decided by the first number of its random sequence. Knowing that without
    // any terrain skips the other 23.
    private static boolean geodePossible(long seed,int cx,int cz) {
        var entry=placed().stream().filter(e->e.key.equals("amethyst_geodes")).findFirst().orElseThrow();
        var random=new WorldgenRandom(new XoroshiroRandomSource(0));
        random.setFeatureSeed(random.setDecorationSeed(seed,cx<<4,cz<<4),entry.index,entry.step);
        return random.nextFloat()<1f/24;
    }
    /** The finds of one kind around (x, z), nearest first, as findStructures reports structures. */
    static int find(SeedEngine.Feature f,long seed,RandomState state,int x,int z,java.util.function.BooleanSupplier running,List<Map<String,Object>> out,int limit,boolean confirm,
            java.util.function.BiFunction<BlockPos,Boolean,List<Map<String,Object>>> companions) {
        var chunks=new ArrayList<int[]>();int reach=f.radius()+16;
        for(int cx=(x-reach)>>4;cx<=(x+reach)>>4;cx++)for(int cz=(z-reach)>>4;cz<=(z+reach)>>4;cz++) {
            // The nearest a find in this chunk could be: a dungeon's spawner or a geode's middle can sit a little outside it.
            int dx=Math.max(0,Math.max((cx<<4)-12-x,x-((cx<<4)+27))),dz=Math.max(0,Math.max((cz<<4)-12-z,z-((cz<<4)+27)));
            int near=(int)Math.hypot(dx,dz);
            if(near<=f.radius())chunks.add(new int[]{cx,cz,near});
        }
        chunks.sort(Comparator.comparingInt(c->c[2]));
        var waiting=new PriorityQueue<Find>(Comparator.comparingDouble(g->Math.hypot(g.x()-x,g.z()-z)));
        var cache=FOUND.get();var keys=Set.of(f.key());int taken=0;
        for(int i=0;i<=chunks.size();i++) {
            // A find can be reported once no chunk still to come could hold a nearer one.
            int safe=i<chunks.size()?chunks.get(i)[2]:Integer.MAX_VALUE;
            while(!waiting.isEmpty()&&Math.hypot(waiting.peek().x()-x,waiting.peek().z()-z)<=safe) {
                if(taken>=limit)return taken;
                var find=waiting.poll();var pos=new BlockPos(find.x(),find.y(),find.z());
                List<Map<String,Object>> extra=List.of();
                if(companions!=null&&(extra=companions.apply(pos,confirm))==null)continue;
                out.add(new LinkedHashMap<>(SeedEngine.found(f,pos,x,z,f.key().equals("dungeons")?"dungeon":"amethyst_geode","Predicted from terrain and carved caves")));
                out.addAll(extra);taken++;
            }
            if(i==chunks.size()||taken>=limit||!running.getAsBoolean())break;
            int cx=chunks.get(i)[0],cz=chunks.get(i)[1];
            if(f.key().equals("amethyst_geodes")&&!geodePossible(seed,cx,cz))continue;
            for(var find:cache.computeIfAbsent(seed+":"+f.key()+":"+cx+":"+cz,k->chunk(seed,state,cx,cz,keys))) {
                double d=Math.hypot(find.x()-x,find.z()-z);
                if(d>=f.minRadius()&&d<=f.radius())waiting.add(find);
            }
        }
        return taken;
    }

    /** Everything the game would place in this chunk, of the kinds asked for, as its decoration step would. */
    static List<Find> chunk(long seed,RandomState state,int cx,int cz,Set<String> keys) {
        var finds=new ArrayList<Find>();var written=new HashMap<Long,BlockState>();
        int minY=SeedEngine.heights.getMinY(),height=SeedEngine.heights.getHeight();
        var resolver=SeedEngine.generator.getBiomeSource().createUncachedResolver(state);var biomes=new BiomeManager(resolver,BiomeManager.obfuscateSeed(seed));
        InvocationHandler world=(proxy,method,args)->{
            switch(method.getName()) {
                case "getBlockState","getFluidState": {
                    var pos=(BlockPos)args[0];var block=written.get(pos.asLong());
                    if(block==null) {
                        int y=pos.getY()-minY;
                        block=y<0||y>=height?Blocks.VOID_AIR.defaultBlockState():terrain(seed,state,pos.getX()>>4,pos.getZ()>>4)[((pos.getZ()&15)*16+(pos.getX()&15))*height+y];
                    }
                    return method.getName().equals("getBlockState")?block:block.getFluidState();
                }
                case "setBlock": written.put(((BlockPos)args[0]).asLong(),(BlockState)args[1]);return true;
                case "removeBlock","destroyBlock": written.put(((BlockPos)args[0]).asLong(),Blocks.AIR.defaultBlockState());return true;
                case "getSeed": return seed;
                case "getMinY": return minY;
                case "getHeight": if(args==null||args.length==0)return height;break;
                case "getBiomeManager": return biomes;
                case "getBiome": return biomes.getBiome((BlockPos)args[0]);
                case "getNoiseBiome","getUncachedNoiseBiome": return resolver.getNoiseBiome((Integer)args[0],(Integer)args[1],(Integer)args[2]);
                case "registryAccess": return SeedEngine.access;
                case "ensureCanWrite": return true;
                case "isClientSide": return false;
                case "hashCode": return System.identityHashCode(proxy);
                case "equals": return proxy==args[0];
                case "toString": return "Decorations world";
                case "getLevel","getBlockEntity","getChunkSource","setCurrentlyGenerating","scheduleTick","levelEvent","gameEvent","playSound","addParticle","neighborShapeChanged","updateNeighborsAt","getChunk": return null;
                default:
            }
            if(method.isDefault())return InvocationHandler.invokeDefault(proxy,method,args);
            var type=method.getReturnType();
            return type==boolean.class?(Object)false:type==int.class?(Object)0:type==long.class?(Object)0L:type==float.class?(Object)0f:type==double.class?(Object)0d:null;
        };
        var level=(WorldGenLevel)Proxy.newProxyInstance(WorldGenLevel.class.getClassLoader(),new Class<?>[]{WorldGenLevel.class},world);
        var random=new WorldgenRandom(new XoroshiroRandomSource(0));
        var origin=new BlockPos(cx<<4,minY,cz<<4);
        long decoration=random.setDecorationSeed(seed,origin.getX(),origin.getZ());
        var placer=new FeaturePlacer(level,SeedEngine.generator);
        for(var entry:placed()) {
            if(!keys.contains(entry.key))continue;
            int before=written.size();var snapshot=new HashSet<>(written.keySet());
            random.setFeatureSeed(decoration,entry.index,entry.step);
            try { if(!placer.placeWithBiomeCheck(entry.feature,random,origin))continue; }
            catch(RuntimeException e) { continue; }   // a read this model cannot answer: nothing is claimed for it
            if(written.size()==before)continue;
            // What it built says where it is: a dungeon by its spawner, a geode by the middle of its budding amethyst.
            long sx=0,sy=0,sz=0;int n=0;
            for(var block:written.entrySet()) {
                if(snapshot.contains(block.getKey()))continue;
                var pos=BlockPos.of(block.getKey());
                if(block.getValue().is(Blocks.SPAWNER))finds.add(new Find(entry.key,pos.getX(),pos.getY(),pos.getZ()));
                else if(block.getValue().is(Blocks.BUDDING_AMETHYST)){sx+=pos.getX();sy+=pos.getY();sz+=pos.getZ();n++;}
            }
            if(n>0)finds.add(new Find(entry.key,(int)Math.round((double)sx/n),(int)Math.round((double)sy/n),(int)Math.round((double)sz/n)));
        }
        return finds;
    }
}
