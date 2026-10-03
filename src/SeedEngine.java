import com.google.gson.*;
import java.io.*;
import java.nio.file.*;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;
import net.minecraft.SharedConstants;
import net.minecraft.server.Bootstrap;
import net.minecraft.server.packs.PackType;
import net.minecraft.server.packs.repository.ServerPacksSource;
import net.minecraft.server.packs.resources.MultiPackResourceManager;
import net.minecraft.core.*;
import net.minecraft.core.registries.*;
import net.minecraft.resources.*;
import net.minecraft.tags.TagLoader;
import net.minecraft.world.level.*;
import net.minecraft.world.level.biome.*;
import net.minecraft.world.level.chunk.*;
import net.minecraft.world.level.levelgen.*;
import net.minecraft.world.level.levelgen.densityfunction.SamplerContext;
import net.minecraft.world.level.levelgen.presets.WorldPresets;
import net.minecraft.world.level.levelgen.structure.*;
import net.minecraft.world.level.levelgen.structure.placement.*;
import net.minecraft.world.level.levelgen.structure.templatesystem.*;
import net.minecraft.world.level.storage.LevelStorageSource;
import net.minecraft.util.datafix.DataFixers;
import net.minecraft.world.level.levelgen.LegacyRandomSource;

public final class SeedEngine {
    static final PrintStream OUTPUT=System.out;
    static final Gson JSON=new Gson();
    static RegistryAccess access;
    static NoiseBasedChunkGenerator generator;
    static StructureTemplateManager templates;
    static final Map<String,Holder.Reference<StructureSet>> sets=new TreeMap<>();
    static LevelHeightAccessor heights;
    static volatile Job active;
    static final ScheduledExecutorService PROGRESS=Executors.newSingleThreadScheduledExecutor(r->{var t=new Thread(r,"search-progress");t.setDaemon(true);return t;});
    static final Map<String,String> biomeNames=new TreeMap<>();
    static final ConcurrentMap<Integer,List<int[]>> biomeOffsets=new ConcurrentHashMap<>();
    static final ExecutorService MAP_WORKERS=new ThreadPoolExecutor(2,2,0,TimeUnit.SECONDS,new ArrayBlockingQueue<>(32),r->{var t=new Thread(r,"map-tile");t.setDaemon(true);return t;});
    static final ThreadLocal<Map<Long,RandomState>> MAP_STATES=ThreadLocal.withInitial(()->new LinkedHashMap<>(4,.75f,true){protected boolean removeEldestEntry(Map.Entry<Long,RandomState> e){return size()>3;}});
    static synchronized void emit(Object obj) { OUTPUT.println("SEEDSCOUT " + JSON.toJson(obj)); OUTPUT.flush(); }
    static void initialize() throws Exception {
        // Keep game logging separate from the machine-readable protocol.
        System.setOut(System.err);
        SharedConstants.tryDetectVersion(); Bootstrap.bootStrap();
        var resources=new MultiPackResourceManager(PackType.SERVER_DATA,List.of(ServerPacksSource.createVanillaPackSource().fullResources()));
        var builtin=RegistryAccess.fromRegistryOfRegistries(BuiltInRegistries.REGISTRY);
        var tags=TagLoader.loadTagsForExistingRegistries(resources,builtin);
        var lookups=TagLoader.buildUpdatedLookups(builtin,tags);
        var world=RegistryDataLoader.load(resources,lookups,RegistryDataLoader.WORLD_REGISTRIES,ForkJoinPool.commonPool()).join();
        tags.forEach(Registry.PendingTags::apply);
        var registryList=new ArrayList<Registry<?>>();
        builtin.registries().forEach(e->registryList.add(e.value()));
        world.registries().forEach(e->registryList.add(e.value()));
        access=new RegistryAccess.ImmutableRegistryAccess(registryList).freeze();
        generator=(NoiseBasedChunkGenerator)access.lookupOrThrow(Registries.WORLD_PRESET).getOrThrow(WorldPresets.NORMAL).value().overworld().orElseThrow().generator();
        heights=LevelHeightAccessor.create(generator.getMinY(),generator.getGenDepth());
        var scratch=LevelStorageSource.createDefault(Path.of("runtime/template-storage")).createAccess("template-reader");
        templates=new StructureTemplateManager(resources,scratch,DataFixers.getDataFixer(),access.lookupOrThrow(Registries.BLOCK));
        access.lookupOrThrow(Registries.STRUCTURE_SET).listElements().forEach(h->{
            if(h.value().structures().stream().anyMatch(e->e.structure().value().biomes().stream().anyMatch(generator.getBiomeSource().possibleBiomes()::contains))) sets.put(h.key().identifier().getPath(),h);
        });
        generator.getBiomeSource().possibleBiomes().forEach(h->h.unwrapKey().ifPresent(k->biomeNames.put(k.identifier().getPath(),k.identifier().toString())));
        emit(Map.of("type","ready","version",SharedConstants.getCurrentVersion().id(),"sets",sets.keySet(),"biomes",biomeNames.keySet()));
    }
    public static void main(String[] args) throws Exception {
        initialize();
        var reader=new BufferedReader(new InputStreamReader(System.in));
        for(String line;(line=reader.readLine())!=null;) {
            JsonObject request=null;
            try {
                request=JsonParser.parseString(line).getAsJsonObject();
                String command=request.has("cmd")?request.get("cmd").getAsString():"inspect";
            if(command.equals("start")) { if(active!=null && active.finished.get()<active.threads)throw new IllegalStateException("Stop the current search first"); active=new Job(request); active.start(); }
                else if(command.equals("stop")) { if(active!=null)active.running.set(false); }
                else if(command.equals("tile")) { final var tileRequest=request;MAP_WORKERS.execute(()->{try{emit(Map.of("type","response","id",tileRequest.get("id").getAsLong(),"data",tile(tileRequest)));}catch(Throwable e){emit(Map.of("type","error","id",tileRequest.get("id").getAsLong(),"message",e.toString()));}}); }
                else emit(Map.of("type","response","id",request.get("id").getAsLong(),"data",inspect(request)));
            }
            catch(Throwable error) { emit(Map.of("type","error","id",request!=null&&request.has("id")?request.get("id").getAsLong():-1L,"message",error.toString())); error.printStackTrace(System.err); }
        }
        if(active!=null)active.running.set(false);
        PROGRESS.shutdown();
        MAP_WORKERS.shutdownNow();
    }
    static Object tile(JsonObject r) {
        long seed=Long.parseLong(r.get("seed").getAsString());int x=r.get("x").getAsInt(),z=r.get("z").getAsInt(),step=r.get("step").getAsInt(),size=32;
        var state=MAP_STATES.get().computeIfAbsent(seed,s->RandomState.create(access.lookupOrThrow(Registries.NOISE),s,generator.generatorSettings().value()));
        var biomeManager=new BiomeManager(generator.getBiomeSource().createUncachedResolver(state),BiomeManager.obfuscateSeed(seed));
        var palette=new ArrayList<String>();var paletteIndices=new HashMap<String,Integer>();var biomes=new int[size*size];var elevation=new int[size*size];var water=new boolean[size*size];var shade=new int[size*size];
        for(int row=0;row<size;row++)for(int col=0;col<size;col++) {
            int bx=x+col*step,bz=z+row*step,i=row*size+col;
            var column=generator.getBaseColumn(bx,bz,heights,state);int top=column.topBlockY();
            elevation[i]=column.findTopSolidBlockY();var topBlock=column.getBlock(top);water[i]=topBlock!=null&&!topBlock.getFluidState().isEmpty();
            shade[i]=Math.clamp(column.surfaceGradientX()-column.surfaceGradientZ(),-30,30);
            String name=biomeManager.getBiome(bx,top,bz).unwrapKey().orElseThrow().identifier().getPath();
            biomes[i]=paletteIndices.computeIfAbsent(name,k->{palette.add(k);return palette.size()-1;});
        }
        return Map.of("seed",Long.toString(seed),"x",x,"z",z,"step",step,"size",size,"palette",palette,"biomes",biomes,"elevation",elevation,"water",water,"shade",shade);
    }
    static Object inspect(JsonObject request) {
        long seed=Long.parseLong(request.get("seed").getAsString());
        var wanted=request.has("features")?request.getAsJsonArray("features"):new JsonArray();
        var result=evaluate(seed,request,wanted,null);
        if(result==null)return Map.of("seed",Long.toString(seed),"match",false);
        result.put("match",true);return result;
    }
    record Feature(String kind,String key,int radius) {}
    static List<Feature> parseFeatures(JsonArray wanted) {
        var result=new ArrayList<Feature>();
        for(var item:wanted) {var f=item.getAsJsonObject();result.add(new Feature(f.get("kind").getAsString(),f.get("key").getAsString(),f.get("radius").getAsInt()));}
        // Reject rare structures before scanning thousands of biome points.
        result.sort(Comparator.comparingInt((Feature f)->f.kind.equals("biome")?1:0).thenComparingInt(Feature::radius));
        return result;
    }
    static Map<String,Object> evaluate(long seed,JsonObject request,JsonArray wanted,Job job) {
        var state=RandomState.create(access.lookupOrThrow(Registries.NOISE),seed,generator.generatorSettings().value());
        var origin=generator.getOrigin(state);
        int x=request.has("anchor") && request.get("anchor").getAsString().equals("custom")?request.get("x").getAsInt():origin.getMiddleBlockX();
        int z=request.has("anchor") && request.get("anchor").getAsString().equals("custom")?request.get("z").getAsInt():origin.getMiddleBlockZ();
        var structState=ChunkGeneratorStructureState.createForNormal(state,seed,origin,generator.getBiomeSource(),access.lookupOrThrow(Registries.STRUCTURE_SET));
        var found=new ArrayList<Map<String,Object>>();
        var parsed=parseFeatures(wanted);
        for(var feature:parsed) {
            if(job!=null && !job.running.get())return null;
            Map<String,Object> match=feature.kind.equals("structure")?findStructure(feature,seed,state,structState,x,z,job):findBiome(feature,seed,state,x,z,job,request.has("biomeMode")&&request.get("biomeMode").getAsString().equals("fast"));
            if(match==null)return null;
            found.add(match);
        }
        int cluster=request.has("cluster")?request.get("cluster").getAsInt():0;
        // This tests the selected nearest matches; it does not exhaust all alternative clusters.
        if(cluster>0)for(var a:found)for(var b:found) {
            if(Math.hypot(((Number)a.get("x")).intValue()-((Number)b.get("x")).intValue(),((Number)a.get("z")).intValue()-((Number)b.get("z")).intValue())>cluster)return null;
        }
        var result=new LinkedHashMap<String,Object>();result.put("seed",Long.toString(seed));result.put("spawnX",origin.getMiddleBlockX());result.put("spawnZ",origin.getMiddleBlockZ());
        result.put("anchorX",x);result.put("anchorZ",z);result.put("features",found);result.put("version",SharedConstants.getCurrentVersion().id());
        result.put("spawnAccuracy","Snapshot spawn-region estimate; final player spawn may shift.");
        return result;
    }
    static Map<String,Object> found(Feature f,BlockPos pos,int x,int z,String detail,String confidence) {
        return Map.of("kind",f.kind,"key",f.key,"x",pos.getX(),"y",pos.getY(),"z",pos.getZ(),"distance",Math.round(Math.hypot(pos.getX()-x,pos.getZ()-z)),"detail",detail,"confidence",confidence);
    }
    static Map<String,Object> findStructure(Feature f,long seed,RandomState state,ChunkGeneratorStructureState structState,int x,int z,Job job) {
        var holder=sets.get(f.key);if(holder==null)throw new IllegalArgumentException("Unknown structure: "+f.key);
        var set=holder.value(); var placement=set.placement();
        int minX=Math.floorDiv(x-f.radius-32,16),maxX=Math.floorDiv(x+f.radius+32,16),minZ=Math.floorDiv(z-f.radius-32,16),maxZ=Math.floorDiv(z+f.radius+32,16);
        var candidates=new ArrayList<ChunkPos>();
        if(placement instanceof RandomSpreadStructurePlacement spread) {
            int s=spread.spacing();for(int rx=Math.floorDiv(minX,s);rx<=Math.floorDiv(maxX,s);rx++)for(int rz=Math.floorDiv(minZ,s);rz<=Math.floorDiv(maxZ,s);rz++)candidates.add(spread.getPotentialStructureChunk(seed,rx*s,rz*s));
        } else if(placement instanceof ConcentricRingsStructurePlacement rings) candidates.addAll(structState.getRingPositionsFor(rings));
        else for(int cx=minX;cx<=maxX;cx++)for(int cz=minZ;cz<=maxZ;cz++)candidates.add(new ChunkPos(cx,cz));
        candidates.removeIf(c->Math.hypot(placement.getLocatePos(c).getX()-x,placement.getLocatePos(c).getZ()-z)>f.radius);
        candidates.sort(Comparator.comparingDouble(c->Math.hypot(placement.getLocatePos(c).getX()-x,placement.getLocatePos(c).getZ()-z)));
        var climate=state.createClimateSampler(SamplerContext.EMPTY_UNCACHED);
        for(var c:candidates) {
            if(job!=null && !job.running.get())return null;
            if(!placement.isStructureChunk(structState,c.x(),c.z()))continue;
            var entries=new ArrayList<>(set.structures());
            var random=new WorldgenRandom(new LegacyRandomSource(0));random.setLargeFeatureSeed(seed,c.x(),c.z());
            int total=entries.stream().mapToInt(StructureSet.StructureSelectionEntry::weight).sum();
            while(!entries.isEmpty()) {
                int pick=entries.size()==1?0:random.nextInt(total),index=0;
                if(entries.size()>1)for(;index<entries.size()-1;index++){pick-=entries.get(index).weight();if(pick<0)break;}
                var entry=entries.remove(index);total-=entry.weight();var structure=entry.structure().value();
                var start=structure.generate(entry.structure(),Level.OVERWORLD,access,generator,generator.getBiomeSource(),climate,state,templates,seed,c,0,heights,structure.biomes()::contains);
                if(start.isValid()) {
                    var pos=placement.getLocatePos(c);
                    return found(f,new BlockPos(pos.getX(),start.getBoundingBox().minY(),pos.getZ()),x,z,entry.structure().unwrapKey().orElseThrow().identifier().getPath(),"Snapshot structure start confirmed");
                }
            }
        }
        return null;
    }
    static Map<String,Object> findBiome(Feature f,long seed,RandomState state,int x,int z,Job job,boolean fast) {
        if(!biomeNames.containsKey(f.key))throw new IllegalArgumentException("Unknown biome: "+f.key);
        int y=(f.key.equals("deep_dark")||f.key.equals("lush_caves")||f.key.equals("dripstone_caves")||f.key.equals("sulfur_caves"))?-32:64;
        var resolver=generator.getBiomeSource().createUncachedResolver(state);
        var manager=new BiomeManager(resolver,BiomeManager.obfuscateSeed(seed));
        // A sampled scan can miss a tiny patch, but every returned biome point is real.
        var offsets=biomeOffsets.computeIfAbsent(f.radius,r->{var list=new ArrayList<int[]>();for(int dx=-r/32;dx<=r/32;dx++)for(int dz=-r/32;dz<=r/32;dz++)if(Math.hypot(dx*32,dz*32)<=r)list.add(new int[]{dx*32,dz*32});list.sort(Comparator.comparingDouble(a->Math.hypot(a[0],a[1])));return list;});
        for(var offset:offsets) {
            if(job!=null && !job.running.get())return null;
            int bx=Math.floorDiv(x+offset[0],4)*4,bz=Math.floorDiv(z+offset[1],4)*4;
            if(Math.hypot(bx-x,bz-z)>f.radius)continue;
            if((!fast&&y!=-32)||resolver.getNoiseBiome(Math.floorDiv(bx,4),Math.floorDiv(y,4),Math.floorDiv(bz,4)).unwrapKey().orElseThrow().identifier().getPath().equals(f.key)) {
                int confirmedY=y==-32?y:generator.getBaseColumn(bx,bz,heights,state).topBlockY();
                if(!manager.getBiome(bx,confirmedY,bz).unwrapKey().orElseThrow().identifier().getPath().equals(f.key))continue;
                return found(f,new BlockPos(bx,confirmedY,bz),x,z,"32-block candidate scan; block-biome boundary and terrain height checked",y==-32?"Snapshot cave-biome point confirmed":"Snapshot surface-biome point confirmed");
            }
        }
        return null;
    }
    static final class Job {
        final JsonObject request;final JsonArray features;final long id,start,limit;final int threads,maxMatches;
        final AtomicBoolean running=new AtomicBoolean(true);final AtomicLong next=new AtomicLong();final LongAdder tested=new LongAdder();final AtomicInteger matches=new AtomicInteger(),finished=new AtomicInteger();
        final java.util.TreeSet<Long> unfinished=new java.util.TreeSet<>();
        synchronized long claim(){long index=next.get();if(index>=limit)return -1;unfinished.add(index);next.incrementAndGet();return index;}
        synchronized void complete(long index){unfinished.remove(index);}
        synchronized long checkpoint(){return unfinished.isEmpty()?next.get():unfinished.first();}
        final long began=System.nanoTime();volatile String failure="";ScheduledFuture<?> reporting;
        Job(JsonObject r){request=r;features=r.getAsJsonArray("features");id=r.get("id").getAsLong();start=Long.parseLong(r.get("seed").getAsString());limit=r.get("limit").getAsLong();threads=r.get("threads").getAsInt();maxMatches=r.get("maxMatches").getAsInt();}
        void report(boolean done){emit(Map.of("type","progress","id",id,"tested",tested.sum(),"matches",Math.min(matches.get(),maxMatches),"seconds",(System.nanoTime()-began)/1e9,"running",!done,"error",failure,"nextSeed",Long.toString(start+checkpoint())));}
        void start(){reporting=PROGRESS.scheduleAtFixedRate(()->report(false),0,500,TimeUnit.MILLISECONDS);for(int i=0;i<threads;i++){new Thread(()->{
            try {while(running.get()){long index=claim();if(index<0)break;var result=evaluate(start+index,request,features,this);if(!running.get())break;tested.increment();complete(index);if(result!=null){int count=matches.incrementAndGet();if(count<=maxMatches)emit(Map.of("type","match","id",id,"data",result));if(count>=maxMatches)running.set(false);}}}
            catch(Throwable e){failure=e.toString();running.set(false);e.printStackTrace(System.err);}
            finally{if(finished.incrementAndGet()==threads){running.set(false);reporting.cancel(false);report(true);}}
        },"seed-worker-"+i).start();}}
    }
}
