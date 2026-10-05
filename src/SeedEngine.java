import com.google.gson.*;
import java.io.*;
import java.nio.file.*;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;
import java.util.function.BiFunction;
import java.util.function.ToDoubleFunction;
import java.util.stream.*;
import net.minecraft.SharedConstants;
import net.minecraft.server.Bootstrap;
import net.minecraft.server.packs.PackType;
import net.minecraft.server.packs.repository.ServerPacksSource;
import net.minecraft.server.packs.resources.MultiPackResourceManager;
import net.minecraft.core.*;
import net.minecraft.core.registries.*;
import net.minecraft.resources.*;
import net.minecraft.nbt.CompoundTag;
import net.minecraft.tags.BiomeTags;
import net.minecraft.tags.TagLoader;
import net.minecraft.world.level.*;
import net.minecraft.world.level.biome.*;
import net.minecraft.world.level.chunk.*;
import net.minecraft.world.level.levelgen.*;
import net.minecraft.world.level.levelgen.densityfunction.DensityVolume;
import net.minecraft.world.level.levelgen.densityfunction.SamplerContext;
import net.minecraft.util.context.ContextMap;
import net.minecraft.world.level.dimension.LevelStem;
import net.minecraft.world.level.levelgen.presets.WorldPresets;
import net.minecraft.world.level.levelgen.structure.*;
import net.minecraft.world.level.levelgen.structure.placement.*;
import net.minecraft.world.level.levelgen.structure.structures.OceanMonumentStructure;
import net.minecraft.world.level.levelgen.structure.structures.StrongholdPieces;
import net.minecraft.world.level.levelgen.structure.structures.StrongholdStructure;
import net.minecraft.world.level.levelgen.structure.structures.RuinedPortalPiece;
import net.minecraft.world.level.levelgen.structure.structures.ShipwreckPieces;
import net.minecraft.world.level.levelgen.structure.pools.*;
import net.minecraft.world.level.levelgen.structure.pieces.StructurePieceSerializationContext;
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
    static StructurePieceSerializationContext pieceContext;
    static final Map<String,Holder.Reference<StructureSet>> sets=new TreeMap<>();
    static final Map<String,String> variantDetails=new TreeMap<>();
    static final Map<String,List<String>> structureVariants=new TreeMap<>();
    static final Map<String,List<String>> structureTemplates=new TreeMap<>();
    static LevelHeightAccessor heights;
    // `generator` and `heights` above are the Overworld's, which nearly everything here works in. A structure of
    // another dimension is checked with that dimension's generator, in that dimension's own coordinates.
    record Dim(String name,ResourceKey<Level> level,NoiseBasedChunkGenerator generator,LevelHeightAccessor heights) {}
    static Dim OVERWORLD,NETHER,END;
    static final Map<String,Dim> dimensions=new TreeMap<>();
    static Dim dimOf(String key) { return dimensions.getOrDefault(key,OVERWORLD); }
    static Dim dimOf(Feature f) { return f.kind.equals("structure")?dimOf(f.key):OVERWORLD; }
    // A seed's noise and structure placement in another dimension. Made only when a condition asks for it.
    record Realm(RandomState state,ChunkGeneratorStructureState structures) {}
    static final ThreadLocal<Map<String,Realm>> REALMS=ThreadLocal.withInitial(()->new LinkedHashMap<>(8,.75f,true){protected boolean removeEldestEntry(Map.Entry<String,Realm> e){return size()>6;}});
    static Realm realm(Dim dim,long seed) {
        return REALMS.get().computeIfAbsent(dim.name+seed,k->{
            var state=RandomState.create(access.lookupOrThrow(Registries.NOISE),seed,dim.generator.generatorSettings().value());
            return new Realm(state,ChunkGeneratorStructureState.createForNormal(state,seed,dim.generator.getOrigin(state),dim.generator.getBiomeSource(),access.lookupOrThrow(Registries.STRUCTURE_SET)));
        });
    }
    // The position a condition in dimension `to` is measured from, given a position in dimension `from`: the place a
    // portal leads to between the Overworld and the Nether (one Nether block is eight Overworld blocks), and the
    // centre of the End, where every End portal arrives.
    static int[] frame(Dim from,Dim to,int x,int z) {
        if(from==to)return new int[]{x,z};
        if(to==END)return new int[]{0,0};
        if(to==NETHER)return new int[]{Math.floorDiv(x,8),Math.floorDiv(z,8)};
        return from==NETHER?new int[]{x*8,z*8}:new int[]{x,z};
    }
    static void register(String key,Holder.Reference<StructureSet> holder,String detail,Dim dim) { sets.put(key,holder);dimensions.put(key,dim);if(detail!=null)variantDetails.put(key,detail); }
    static volatile Job active;
    static final ScheduledExecutorService PROGRESS=Executors.newSingleThreadScheduledExecutor(r->{var t=new Thread(r,"search-progress");t.setDaemon(true);return t;});
    static final Map<String,String> biomeNames=new TreeMap<>();
    static final ConcurrentMap<Integer,List<int[]>> biomeOffsets=new ConcurrentHashMap<>();
    static final int CORES=Runtime.getRuntime().availableProcessors();
    // Tile generation scales with threads; half the cores keeps the map quick and still leaves room for a running search.
    static final int MAP_THREADS=Math.clamp(CORES/2,2,16);
    static final ThreadPoolExecutor MAP_WORKERS=new ThreadPoolExecutor(MAP_THREADS,MAP_THREADS,0,TimeUnit.SECONDS,new ArrayBlockingQueue<>(512),r->{var t=new Thread(r,"map-tile");t.setDaemon(true);t.setPriority(Thread.NORM_PRIORITY+1);return t;});
    static final ThreadLocal<Map<Long,RandomState>> MAP_STATES=ThreadLocal.withInitial(()->new LinkedHashMap<>(4,.75f,true){protected boolean removeEldestEntry(Map.Entry<Long,RandomState> e){return size()>3;}});
    // The structure state carries the world origin and, once asked for, the stronghold ring positions.
    static final ThreadLocal<Map<Long,ChunkGeneratorStructureState>> MAP_STRUCTURES=ThreadLocal.withInitial(()->new LinkedHashMap<>(4,.75f,true){protected boolean removeEldestEntry(Map.Entry<Long,ChunkGeneratorStructureState> e){return size()>3;}});
    static RandomState mapState(long seed) { return MAP_STATES.get().computeIfAbsent(seed,s->RandomState.create(access.lookupOrThrow(Registries.NOISE),s,generator.generatorSettings().value())); }
    static ChunkGeneratorStructureState mapStructures(long seed) {
        var state=mapState(seed);
        return MAP_STRUCTURES.get().computeIfAbsent(seed,s->ChunkGeneratorStructureState.createForNormal(state,s,generator.getOrigin(state),generator.getBiomeSource(),access.lookupOrThrow(Registries.STRUCTURE_SET)));
    }
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
        var stems=access.lookupOrThrow(Registries.WORLD_PRESET).getOrThrow(WorldPresets.NORMAL).value().createWorldDimensions();
        OVERWORLD=new Dim("overworld",Level.OVERWORLD,generator,heights);
        var nether=(NoiseBasedChunkGenerator)stems.get(LevelStem.NETHER).orElseThrow().generator();var end=(NoiseBasedChunkGenerator)stems.get(LevelStem.END).orElseThrow().generator();
        NETHER=new Dim("nether",Level.NETHER,nether,LevelHeightAccessor.create(nether.getMinY(),nether.getGenDepth()));
        END=new Dim("end",Level.END,end,LevelHeightAccessor.create(end.getMinY(),end.getGenDepth()));
        var scratch=LevelStorageSource.createDefault(Path.of("runtime/template-storage")).createAccess("template-reader");
        templates=new StructureTemplateManager(resources,scratch,DataFixers.getDataFixer(),access.lookupOrThrow(Registries.BLOCK));
        pieceContext=new StructurePieceSerializationContext(resources,access,templates);
        access.lookupOrThrow(Registries.STRUCTURE_SET).listElements().forEach(h->{
            if(h.value().structures().stream().anyMatch(e->e.structure().value().biomes().stream().anyMatch(generator.getBiomeSource().possibleBiomes()::contains))) sets.put(h.key().identifier().getPath(),h);
        });
        sets.put("huge_ruined_portals",sets.get("ruined_portals"));
        for(String family:List.of("ruined_portals","huge_ruined_portals"))
            for(var placement:RuinedPortalPiece.VerticalPlacement.values())if(placement!=RuinedPortalPiece.VerticalPlacement.IN_NETHER)
                sets.put(family+"_"+placement.getSerializedName(),sets.get("ruined_portals"));
        for(String family:List.of("villages","mineshafts","ocean_ruins","shipwrecks","abandoned_camp","igloos","ruined_portals","huge_ruined_portals")) {
            var holder=sets.get(family);var variants=new ArrayList<String>();
            for(var entry:holder.value().structures())if(entry.structure().value().biomes().stream().anyMatch(generator.getBiomeSource().possibleBiomes()::contains)) {
                String detail=entry.structure().unwrapKey().orElseThrow().identifier().getPath(),key=family+"__"+detail;
                sets.put(key,holder);variantDetails.put(key,detail);variants.add(key);
            }
            structureVariants.put(family,variants);
        }
        structureTemplates.put("shipwrecks",templates.listTemplates().filter(id->id.getNamespace().equals("minecraft")&&id.getPath().startsWith("shipwreck/")).map(Identifier::getPath).distinct().sorted().toList());
        // For these the "template" is a trait of the built structure rather than a template file; see templateOf.
        structureTemplates.put("villages",List.of("inhabited","abandoned"));
        structureTemplates.put("ocean_ruins",List.of("single","cluster"));
        structureTemplates.put("igloos",List.of("basement","no_basement"));
        // The other dimensions. A fortress and a bastion share one set, as the game places one or the other at each
        // of its positions; the Nether's ruined portal is the Overworld set's sixth structure.
        var every=new HashMap<String,Holder.Reference<StructureSet>>();access.lookupOrThrow(Registries.STRUCTURE_SET).listElements().forEach(h->every.put(h.key().identifier().getPath(),h));
        register("fortresses",every.get("nether_complexes"),"fortress",NETHER);
        register("bastion_remnants",every.get("nether_complexes"),"bastion_remnant",NETHER);
        register("nether_fossils",every.get("nether_fossils"),null,NETHER);
        register("nether_ruined_portals",every.get("ruined_portals"),"ruined_portal_nether",NETHER);
        register("end_cities",every.get("end_cities"),null,END);
        structureTemplates.put("bastion_remnants",List.of("housing","stables","treasure","bridge"));
        structureTemplates.put("end_cities",List.of("ship","no_ship"));
        generator.getBiomeSource().possibleBiomes().forEach(h->h.unwrapKey().ifPresent(k->biomeNames.put(k.identifier().getPath(),k.identifier().toString())));
        var ready=new LinkedHashMap<String,Object>(Map.of("type","ready","version",SharedConstants.getCurrentVersion().id(),"sets",sets.keySet(),"biomes",biomeNames.keySet(),"cores",CORES,"mapWorkers",MAP_THREADS,"structureVariants",structureVariants,"variantDetails",variantDetails,"structureTemplates",structureTemplates));
        ready.put("structurePlacements",Map.of("shipwrecks",ShipwreckPlacement.OPTIONS,"villages",List.of("blacksmith","no_blacksmith")));
        var named=new TreeMap<String,String>();dimensions.forEach((key,dim)->named.put(key,dim.name));ready.put("dimensions",named);
        var keys=new TreeSet<>(sets.keySet());keys.addAll(Decorations.KEYS.keySet());ready.put("sets",keys);ready.put("predicted",new TreeSet<>(Decorations.KEYS.keySet()));emit(ready);
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
                else if(command.equals("world")) { if(world!=null && world.finished.get()<world.threads)throw new IllegalStateException("Stop the current search of this seed first"); world=new WorldJob(request); world.start(); }
                else if(command.equals("worldstop")) { if(world!=null)world.running.set(false); }
                else if(command.equals("config")) {
                    // The pool grows by raising the maximum first and shrinks by lowering the core size first.
                    int threads=Math.clamp(request.get("mapThreads").getAsInt(),1,CORES);
                    if(threads>MAP_WORKERS.getMaximumPoolSize()){MAP_WORKERS.setMaximumPoolSize(threads);MAP_WORKERS.setCorePoolSize(threads);}
                    else{MAP_WORKERS.setCorePoolSize(threads);MAP_WORKERS.setMaximumPoolSize(threads);}
                }
                else if(List.of("tile","point","scan","structures","structure").contains(command)) { final var tileRequest=request;MAP_WORKERS.execute(()->{try{emit(Map.of("type","response","id",tileRequest.get("id").getAsLong(),"data",switch(command){case "point"->point(tileRequest);case "scan"->scan(tileRequest);case "structures"->structures(tileRequest);case "structure"->structure(tileRequest);default->tile(tileRequest);}));}catch(Throwable e){emit(Map.of("type","error","id",tileRequest.get("id").getAsLong(),"message",e.toString()));}}); }
                else emit(Map.of("type","response","id",request.get("id").getAsLong(),"data",inspect(request)));
            }
            catch(Throwable error) { emit(Map.of("type","error","id",request!=null&&request.has("id")?request.get("id").getAsLong():-1L,"message",error.toString())); error.printStackTrace(System.err); }
        }
        if(active!=null)active.running.set(false);
        PROGRESS.shutdown();
        MAP_WORKERS.shutdownNow();
    }
    // A noise chunk over any volume of columns, with or without aquifers. The generator only offers one chunk or one
    // full column with aquifers (getBaseColumn), so its fluid picker is borrowed and the noise chunk built directly.
    static Aquifer.FluidPicker fluids;
    static NoiseChunk noiseChunk(RandomState state,DensityVolume volume,boolean aquifers) {
        var settings=generator.generatorSettings().value();
        if(fluids==null) try { var f=NoiseBasedChunkGenerator.class.getDeclaredField("globalFluidPicker");f.setAccessible(true);fluids=(Aquifer.FluidPicker)((java.util.function.Supplier<?>)f.get(generator)).get(); } catch(ReflectiveOperationException e) { throw new IllegalStateException(e); }
        return new NoiseChunk(state,volume,ContextMap.EMPTY,settings.noiseRouter().finalDensity(),aquifers?settings.aquifers().orElse(null):null,fluids);
    }
    // What the map needs from a terrain column: the highest solid block, the highest block of any kind, and whether that one is a fluid.
    record Surface(int ground,int top,boolean water) {
        static Surface of(NoiseColumn column) { int top=column.topBlockY();var block=column.getBlock(top);return new Surface(column.findTopSolidBlockY(),top,block!=null&&!block.getFluidState().isEmpty()); }
    }
    // A slice of a column, "height" blocks up from "low" (a multiple of 16, to stay on the noise cell grid).
    // Null when the slice does not show the surface: nothing solid in it, or its top row is not air.
    static Surface slice(RandomState state,NoiseSettings noise,int bx,int bz,int low,int height,boolean aquifers) {
        low=Math.max(noise.minY(),Math.floorDiv(low,16)*16);int high=Math.min(noise.minY()+noise.height(),low+height);
        try(var chunk=noiseChunk(state,new DensityVolume(1,high-low,1,bx,low,bz),aquifers)) {
            var column=chunk.prepareColumn(0,0);int top=column.topIndexY();
            if(top<0||top>=high-low-1)return null;
            for(int i=top;i>=0;i--)if(column.getBlockForIndex(i)==NoiseColumn.SOLID)return new Surface(column.blockY(i),column.blockY(top),i<top);
            return null;
        }
    }
    // The surface of one column at about a third of the cost of getBaseColumn, which computes all 384 blocks with
    // aquifers. Aquifers are half of that cost and only act below the router's surface estimate, so a column whose
    // ground is clear of the estimate is read from a slice without them, starting at the estimate. The others are
    // redone with aquifers, and with the whole column when the estimate turns out to be unusable.
    // The slices end 128 blocks above the estimate; a floating overhang higher than that is not seen (see README).
    static Surface surface(RandomState state,NoiseSettings noise,int bx,int bz) {
        int estimate=Math.round(state.sampleBlockValueUncached(generator.generatorSettings().value().noiseRouter().chunkSurfaceLevel(),bx,0,bz));
        var quick=slice(state,noise,bx,bz,estimate,144,false);
        // Real ground is 6 to 26 blocks above the estimate; anything far outside that means the estimate cannot be relied on here.
        if(quick!=null&&quick.ground<=estimate+48&&quick.ground>=estimate+(quick.ground>=generator.getSeaLevel()?8:12))return quick;
        var exact=slice(state,noise,bx,bz,estimate-32,176,true);
        if(exact!=null&&exact.ground<=estimate+48)return exact;
        return Surface.of(generator.getBaseColumn(bx,bz,heights,state));
    }
    static Object tile(JsonObject r) {
        long seed=Long.parseLong(r.get("seed").getAsString());int x=r.get("x").getAsInt(),z=r.get("z").getAsInt(),step=r.get("step").getAsInt(),size=32;
        var state=mapState(seed);
        var biomeManager=new BiomeManager(generator.getBiomeSource().createUncachedResolver(state),BiomeManager.obfuscateSeed(seed));
        var palette=new ArrayList<String>();var paletteIndices=new HashMap<String,Integer>();var biomes=new int[size*size];var elevation=new int[size*size];var water=new boolean[size*size];
        if(r.has("mode")&&r.get("mode").getAsString().equals("quick")) {
            // Wide views: the noise biome and the router's surface estimate, with no terrain column (about 100 times
            // cheaper). The estimate reads low and in 8-block steps, so it only feeds relief; water comes from the
            // biome (oceans and rivers), never from height, so lakes and flooded land are left out rather than invented.
            var surface=generator.generatorSettings().value().noiseRouter().chunkSurfaceLevel();
            var resolver=generator.getBiomeSource().createUncachedResolver(state);
            for(int row=0;row<size;row++)for(int col=0;col<size;col++) {
                int bx=x+col*step,bz=z+row*step,i=row*size+col;
                // Measured against real columns the estimate is 6 to 26 blocks low (median 13), so it is raised by 12.
                elevation[i]=Math.round(state.sampleBlockValueUncached(surface,bx,0,bz))+12;
                // Sampled well above that: below the real surface the depth climate would pick cave biomes, while
                // above it depth is the only climate value that changes and it ranks the surface biomes the same.
                String name=resolver.getNoiseBiome(QuartPos.fromBlock(bx),QuartPos.fromBlock(elevation[i]+64),QuartPos.fromBlock(bz)).unwrapKey().orElseThrow().identifier().getPath();
                water[i]=name.contains("ocean")||name.contains("river");
                biomes[i]=paletteIndices.computeIfAbsent(name,k->{palette.add(k);return palette.size()-1;});
            }
            var output=new LinkedHashMap<String,Object>();
            output.putAll(Map.of("seed",Long.toString(seed),"x",x,"z",z,"step",step,"size",size,"palette",palette,"biomes",biomes,"elevation",elevation,"water",water));
            output.put("mode","quick");return output;
        }
        // Every level samples the same terrain model. A low surface estimate must never
        // be interpreted as a lake: it is only a search prefilter, not a water mask.
        var noise=generator.generatorSettings().value().noiseSettings().clampToHeightAccessor(heights);
        String check=r.has("check")?r.get("check").getAsString():"";
        // Up to 2 blocks per sample the tile's columns are neighbours, so one noise chunk over all of them shares its
        // work between columns (15 times faster at 1 block, 6 times at 2). Wider apart they share nothing.
        try(var chunk=step<=2&&!check.equals("columns")?noiseChunk(state,new DensityVolume(size,noise.height(),size,x,noise.minY(),z,step,1,step),true):null) {
            for(int row=0;row<size;row++)for(int col=0;col<size;col++) {
                int bx=x+col*step,bz=z+row*step,i=row*size+col;
                var found=check.equals("columns")?Surface.of(generator.getBaseColumn(bx,bz,heights,state)):chunk!=null?Surface.of(chunk.prepareColumn(col,row)):surface(state,noise,bx,bz);
                elevation[i]=found.ground;water[i]=found.water;
                String name=biomeManager.getBiome(bx,found.top,bz).unwrapKey().orElseThrow().identifier().getPath();
                biomes[i]=paletteIndices.computeIfAbsent(name,k->{palette.add(k);return palette.size()-1;});
            }
        }
        var output=new LinkedHashMap<String,Object>();
        output.putAll(Map.of("seed",Long.toString(seed),"x",x,"z",z,"step",step,"size",size,"palette",palette,"biomes",biomes,"elevation",elevation,"water",water));
        output.put("mode","terrain");return output;
    }
    static Object inspect(JsonObject request) {
        long seed=Long.parseLong(request.get("seed").getAsString());
        var wanted=request.has("features")?request.getAsJsonArray("features"):new JsonArray();
        var result=evaluate(seed,request,wanted,null);
        if(result==null)return Map.of("seed",Long.toString(seed),"match",false);
        result.put("match",true);return result;
    }
    static Object point(JsonObject r) {
        long seed=Long.parseLong(r.get("seed").getAsString());int x=r.get("x").getAsInt(),z=r.get("z").getAsInt();
        var state=mapState(seed);
        var column=generator.getBaseColumn(x,z,heights,state);int top=column.topBlockY();
        var manager=new BiomeManager(generator.getBiomeSource().createUncachedResolver(state),BiomeManager.obfuscateSeed(seed));
        var block=column.getBlock(top);int cx=Math.floorDiv(x,16),cz=Math.floorDiv(z,16);
        var output=new LinkedHashMap<String,Object>();
        output.putAll(Map.of("x",x,"z",z,"chunkX",cx,"chunkZ",cz,"surfaceY",top,"groundY",column.findTopSolidBlockY(),"biome",manager.getBiome(x,top,z).unwrapKey().orElseThrow().identifier().getPath(),"water",block!=null&&!block.getFluidState().isEmpty(),"slimeChunk",WorldgenRandom.seedSlimeChunk(cx,cz,seed,987234911L).nextInt(10)==0));
        // NoiseColumn uses null as its SOLID sentinel; surface materials are assigned in a later generation stage.
        output.put("surfaceBlock",block==null?"solid_terrain":BuiltInRegistries.BLOCK.getKey(block.getBlock()).getPath());
        return output;
    }
    static Object scan(JsonObject r) {
        long seed=Long.parseLong(r.get("seed").getAsString());int x=r.get("x").getAsInt(),z=r.get("z").getAsInt();
        var structState=mapStructures(seed);var state=structState.randomState();
        var found=new ArrayList<Map<String,Object>>();
        for(var f:parseFeatures(r.getAsJsonArray("features"))) {
            var at=frame(OVERWORLD,dimOf(f),x,z);
            if(f.kind.equals("structure"))findStructures(f,seed,state,structState,at[0],at[1],null,found,500-found.size(),true,null);
            else {var b=findBiome(f,seed,state,x,z,null,"terrain");if(b!=null)found.add(b);}
            if(found.size()>=500)break;
        }
        found.sort(Comparator.comparingLong(f->((Number)f.get("distance")).longValue()));
        return Map.of("seed",Long.toString(seed),"x",x,"z",z,"features",found,"limited",found.size()>=500);
    }
    static final int TILE_CAP=600;
    // Every structure whose locate position lies in the half-open block square [x,x+size) x [z,z+size), by generation point only.
    static Object structures(JsonObject r) {
        long seed=Long.parseLong(r.get("seed").getAsString());int x=r.get("x").getAsInt(),z=r.get("z").getAsInt(),size=r.get("size").getAsInt();
        var found=new ArrayList<Map<String,Object>>();var limited=new ArrayList<String>();
        for(var item:r.getAsJsonArray("keys")) {
            String key=item.getAsString();var dim=dimOf(key);
            var structState=dim==OVERWORLD?mapStructures(seed):realm(dim,seed).structures;var state=structState.randomState();var climate=state.createClimateSampler(SamplerContext.EMPTY_UNCACHED);
            var set=set(key);var placement=set.placement();var offset=placement.locateOffset();int count=0;
            // The locate position is the chunk corner plus the placement's offset, so the chunk range is shifted by that offset.
            var candidates=candidates(placement,seed,structState,Math.ceilDiv(x-offset.getX(),16),Math.floorDiv(x+size-1-offset.getX(),16),Math.ceilDiv(z-offset.getZ(),16),Math.floorDiv(z+size-1-offset.getZ(),16)).iterator();
            while(candidates.hasNext()) {
                var c=candidates.next();var pos=placement.getLocatePos(c);
                if(pos.getX()<x||pos.getX()>=x+size||pos.getZ()<z||pos.getZ()>=z+size)continue;
                var hit=startAt(dim,set,seed,state,structState,climate,c,set==set("ruined_portals")||set==set("shipwrecks"));
                if(hit==null||!portalMatches(key,hit,set,seed,state,structState,climate,c))continue;
                // Only a match beyond the cap proves the list is incomplete.
                if(++count>TILE_CAP){limited.add(key);break;}
                var marker=new HashMap<String,Object>(Map.of("kind","structure","key",key,"detail",hit.detail(),"x",pos.getX(),"y",hit.y,"z",pos.getZ(),"confidence","Snapshot generation point confirmed"));
                if(set==set("ruined_portals"))portalFacts(marker,hit);
                if(set==set("shipwrecks"))marker.put("shipwreckTemplate",shipwreckTemplate(hit));
                if(dim!=OVERWORLD)marker.put("dimension",dim.name);
                found.add(marker);
            }
        }
        return Map.of("seed",Long.toString(seed),"x",x,"z",z,"size",size,"features",found,"limited",limited);
    }
    // Builds the start at one locate position, as reported by structures().
    static Object structure(JsonObject r) {
        long seed=Long.parseLong(r.get("seed").getAsString());int x=r.get("x").getAsInt(),z=r.get("z").getAsInt();String key=r.get("key").getAsString();
        var set=set(key);var offset=set.placement().locateOffset();int bx=x-offset.getX(),bz=z-offset.getZ();
        var dim=dimOf(key);var structState=dim==OVERWORLD?mapStructures(seed):realm(dim,seed).structures;var state=structState.randomState();
        var hit=(bx&15)!=0||(bz&15)!=0?null:startAt(dim,set,seed,state,structState,state.createClimateSampler(SamplerContext.EMPTY_UNCACHED),new ChunkPos(bx>>4,bz>>4),true);
        if(hit==null||!portalMatches(key,hit,set,seed,state,structState,state.createClimateSampler(SamplerContext.EMPTY_UNCACHED),new ChunkPos(bx>>4,bz>>4)))return Map.of("valid",false);
        var box=hit.start.getBoundingBox();
        var result=new LinkedHashMap<String,Object>(Map.of("valid",true,"kind","structure","key",key,"detail",hit.detail(),"x",x,"y",hit.y,"z",z,"confidence","Snapshot structure start confirmed",
            "box",Map.of("minX",box.minX(),"minY",box.minY(),"minZ",box.minZ(),"maxX",box.maxX(),"maxY",box.maxY(),"maxZ",box.maxZ()),"pieces",hit.start.getPieces().size()));
        if(set==set("ruined_portals"))portalFacts(result,hit);
        if(set==set("shipwrecks")){result.put("shipwreckTemplate",shipwreckTemplate(hit));result.putAll(ShipwreckPlacement.facts(hit,state));}
        builtFacts(result,hit,set);
        if(dim!=OVERWORLD)result.put("dimension",dim.name);
        var standing=dim==OVERWORLD?stand(hit,state):standInside(hit);
        if(result.containsKey("shipDeckY")&&List.of("afloat","surface").contains(result.get("placement"))) {
            var aboveWater=new LinkedHashMap<String,Object>(standing);
            aboveWater.put("y",Math.max(((Number)standing.get("y")).intValue(),((Number)result.get("shipDeckY")).intValue()+1));
            aboveWater.put("where","above water beside it (predicted)");standing=aboveWater;
        }
        result.put("stand",standing);
        return result;
    }
    // In the Nether and the End there is no surface to stand beside a structure on: the spot is on the floor of the
    // piece the structure grows from (a fortress crossing, a bastion's first hall, an end city's base).
    static Map<String,Object> standInside(Start hit) {
        var piece=hit.start.getPieces().get(0);var inner=piece.getBoundingBox();
        // A fortress grows from a bridge crossing: its deck is four blocks up, with open air over lava below it.
        int floor=inner.minY()+(piece instanceof PoolElementStructurePiece pool?pool.getGroundLevelDelta():piece.getClass().getName().contains("NetherFortressPieces")?5:1);
        return Map.of("x",(inner.minX()+inner.maxX())>>1,"y",Math.min(floor,inner.maxY()),"z",(inner.minZ()+inner.maxZ())>>1,"where","inside it (estimate)");
    }
    // Where to teleport to for a built structure: an open block to stand in, beside it or inside it.
    // Only base terrain and the pieces' boxes are known here, not the placed blocks, so this is a best estimate.
    static Map<String,Object> stand(Start hit,RandomState state) {
        var start=hit.start;var box=start.getBoundingBox();
        // Small surface structures (igloos, shipwrecks, huts, temples) are built at a placeholder height and moved onto
        // the terrain later, so their box height says nothing. Only the others can be told to be buried.
        var type=hit.structure.value();
        boolean placed=type.step()!=GenerationStep.Decoration.SURFACE_STRUCTURES||type instanceof net.minecraft.world.level.levelgen.structure.structures.RuinedPortalStructure;int midX=(box.minX()+box.maxX())>>1,midZ=(box.minZ()+box.maxZ())>>1;
        // Two blocks outside the middle of each side, on the ground there (the sea or river bed when it is under water).
        Map<String,Object> best=null;int bestScore=Integer.MAX_VALUE;
        for(int[] at:new int[][]{{midX,box.minZ()-2},{midX,box.maxZ()+2},{box.minX()-2,midZ},{box.maxX()+2,midZ}}) {
            var column=Surface.of(generator.getBaseColumn(at[0],at[1],heights,state));int y=column.ground+1;
            // A structure that does not reach the ground here is buried: standing above it would not show it.
            if(placed&&box.maxY()<column.ground-2)continue;
            // Prefer a side level with the structure, and dry land over water.
            int score=(placed?Math.abs(y-Math.clamp(y,box.minY(),box.maxY()+1))*4+Math.abs(y-box.minY()):0)+(column.water?8:0);
            if(score<bestScore){bestScore=score;best=Map.of("x",at[0],"y",y,"z",at[1],"where",column.water?"beside it, under water":"beside it");}
        }
        if(best!=null)return best;
        // Buried: inside the first piece (the one the structure grows from), on its floor.
        var piece=start.getPieces().get(0);var inner=piece.getBoundingBox();
        int floor=inner.minY()+(piece instanceof PoolElementStructurePiece pool?pool.getGroundLevelDelta():1);
        int x=(inner.minX()+inner.maxX())>>1,z=(inner.minZ()+inner.maxZ())>>1;
        // The spot inside is a best guess; the ground straight above it is always open, for digging down or looking first.
        var top=Surface.of(generator.getBaseColumn(x,z,heights,state));
        return Map.of("x",x,"y",Math.min(floor,inner.maxY()),"z",z,"where","inside it","above",Map.of("x",x,"y",top.top()+1,"z",z,"water",top.water()));
    }
    // exclude: the seed passes only when nothing matches; otherwise it needs count matches between minRadius and radius.
    // near names the id of another condition: this one is then measured from each of that condition's matches.
    record Feature(String kind,String key,int radius,int minRadius,int count,boolean exclude,String id,String near,List<String> variants,List<String> placements,List<String> templates,List<Feature> or) {}
    // "or" lists alternatives that satisfy the same condition: another structure or biome at the same distances.
    static List<Feature> alternatives(JsonObject f) {
        var result=new ArrayList<Feature>();
        if(f.has("or")&&!f.get("or").isJsonNull())for(var item:f.getAsJsonArray("or")) {
            var alt=item.getAsJsonObject();
            result.add(new Feature(alt.get("kind").getAsString(),alt.get("key").getAsString(),f.get("radius").getAsInt(),f.has("minRadius")?f.get("minRadius").getAsInt():0,f.has("count")?f.get("count").getAsInt():1,false,null,null,List.of(),List.of(),List.of(),List.of()));
        }
        return result;
    }
    // The world spawn point, as the game settles it when a world is created (MinecraftServer.setInitialSpawn):
    // starting from the spawn chunk it walks a square spiral of 11 x 11 chunks and takes the first column, x then z
    // from the chunk's lowest corner, that has dry ground to stand on. On land that is the corner of the spawn chunk
    // itself, 8 blocks from its middle in both directions. With no such column it stays at the chunk's middle.
    // Base terrain only: ice, lakes and other decoration the game places later are not known here.
    static int[] worldSpawn(RandomState state,ChunkPos origin) {
        for(int i=0,x=0,z=0,dx=0,dz=-1;i<121;i++) {
            int minX=(origin.x()+x)<<4,minZ=(origin.z()+z)<<4;
            for(int bx=minX;bx<minX+16;bx++)for(int bz=minZ;bz<minZ+16;bz++) {
                var column=Surface.of(generator.getBaseColumn(bx,bz,heights,state));
                if(!column.water())return new int[]{bx,column.ground()+1,bz};
            }
            if(x==z||x<0&&x==-z||x>0&&x==1-z){int t=dx;dx=-dz;dz=t;}
            x+=dx;z+=dz;
        }
        int x=origin.getMiddleBlockX(),z=origin.getMiddleBlockZ();
        return new int[]{x,generator.getBaseColumn(x,z,heights,state).topBlockY()+1,z};
    }
    // The surface biome at a block position, as the game resolves it.
    static String surfaceBiome(long seed,RandomState state,int x,int z) {
        var manager=new BiomeManager(generator.getBiomeSource().createUncachedResolver(state),BiomeManager.obfuscateSeed(seed));
        return manager.getBiome(x,generator.getBaseColumn(x,z,heights,state).topBlockY(),z).unwrapKey().orElseThrow().identifier().getPath();
    }
    // Slime chunks in the square of chunks reaching "radius" chunks from the one holding the block position.
    static int slimeChunks(long seed,int x,int z,int radius) {
        int count=0,cx=x>>4,cz=z>>4;
        for(int dx=-radius;dx<=radius;dx++)for(int dz=-radius;dz<=radius;dz++)if(WorldgenRandom.seedSlimeChunk(cx+dx,cz+dz,seed,987234911L).nextInt(10)==0)count++;
        return count;
    }
    static List<String> filterValues(JsonObject f,String key) {
        return f.has(key)&&!f.get(key).isJsonNull()?StreamSupport.stream(f.getAsJsonArray(key).spliterator(),false).map(JsonElement::getAsString).toList():List.of();
    }
    static List<Feature> parseFeatures(JsonArray wanted) {
        var result=new ArrayList<Feature>();
        for(var item:wanted) {var f=item.getAsJsonObject();result.add(new Feature(f.get("kind").getAsString(),f.get("key").getAsString(),f.get("radius").getAsInt(),f.has("minRadius")?f.get("minRadius").getAsInt():0,f.has("count")?f.get("count").getAsInt():1,f.has("mode")&&f.get("mode").getAsString().equals("exclude"),f.has("id")?f.get("id").getAsString():null,f.has("near")?f.get("near").getAsString():null,filterValues(f,"variants"),filterValues(f,"placements"),filterValues(f,"templates"),alternatives(f)));}
        // Reject rare structures before scanning thousands of biome points.
        // Cheapest first: structures by their generation point, then biomes, then structures whose type is only known
        // once they are built, then the predicted finds.
        result.sort(Comparator.comparingInt((Feature f)->Decorations.handles(f.key)?3:f.kind.equals("biome")?1:f.templates.isEmpty()&&f.placements.isEmpty()?0:2).thenComparingInt(Feature::radius));
        return result;
    }
    static Map<String,Object> evaluate(long seed,JsonObject request,JsonArray wanted,Job job) {
        var parsed=job==null?parseFeatures(wanted):job.parsed;
        boolean custom=request.has("anchor") && request.get("anchor").getAsString().equals("custom");
        var state=RandomState.create(access.lookupOrThrow(Registries.NOISE),seed,generator.generatorSettings().value());
        var gate=job==null?spawnGate(parsed):job.spawnGate;
        var targets=generator.generatorSettings().value().spawnTarget();
        // The spawn search is the game's own, with the points that cannot win left unsampled (see SpawnSearch).
        var origin=targets.isEmpty()?generator.getOrigin(state)
            : !custom && gate!=null ? SpawnSearch.find(state,targets,(cx,cz)->placementGate(gate,seed,cx,cz))
            : SpawnSearch.find(state,targets,(cx,cz)->chunk->true);
        if(origin==null)return null;
        int x=request.has("anchor") && request.get("anchor").getAsString().equals("custom")?request.get("x").getAsInt():origin.getMiddleBlockX();
        int z=request.has("anchor") && request.get("anchor").getAsString().equals("custom")?request.get("z").getAsInt():origin.getMiddleBlockZ();
        // Conditions on the spawn itself are the cheapest, so they are tested before any structure or biome scan.
        String spawnBiome=null;int slime=-1;
        if(request.has("spawnBiomes")) {
            spawnBiome=surfaceBiome(seed,state,origin.getMiddleBlockX(),origin.getMiddleBlockZ());
            boolean listed=false;for(var item:request.getAsJsonArray("spawnBiomes"))listed|=item.getAsString().equals(spawnBiome);
            if(listed==(request.has("spawnBiomeMode")&&request.get("spawnBiomeMode").getAsString().equals("not")))return null;
        }
        if(request.has("slime")) {
            var rule=request.getAsJsonObject("slime");slime=slimeChunks(seed,x,z,rule.get("radius").getAsInt());
            if(slime<rule.get("count").getAsInt())return null;
        }
        var structState=ChunkGeneratorStructureState.createForNormal(state,seed,origin,generator.getBiomeSource(),access.lookupOrThrow(Registries.STRUCTURE_SET));
        var found=around(seed,state,structState,parsed,x,z,request,job);
        if(found==null)return null;
        // The shape of the land costs the most to read, so it is looked at only where everything else holds.
        if(request.has("landscape")) {
            var land=Landscape.check(request.getAsJsonArray("landscape"),state,x,z,found,()->job==null||job.running.get());
            if(land==null)return null;
            found=new ArrayList<>(found);found.addAll(land);
        }
        var result=new LinkedHashMap<String,Object>();result.put("seed",Long.toString(seed));
        // Distances are measured from the middle of the spawn chunk, which costs nothing to know; the spawn point
        // itself needs terrain, so it is worked out only for the seeds that are reported.
        var spawn=worldSpawn(state,origin);result.put("spawnX",spawn[0]);result.put("spawnY",spawn[1]);result.put("spawnZ",spawn[2]);result.put("anchor",custom?"custom":"spawn");
        result.put("anchorX",x);result.put("anchorZ",z);result.put("features",found);result.put("version",SharedConstants.getCurrentVersion().id());
        result.put("spawnAccuracy","World spawn point from base terrain. Each player appears on a random block within 10 blocks of it.");
        result.put("spawnBiome",spawnBiome!=null?spawnBiome:surfaceBiome(seed,state,spawn[0],spawn[2]));
        if(slime>=0)result.put("slimeChunks",slime);
        return result;
    }
    // Every condition measured from the block position (x, z): the matches to report, or null when one fails.
    static List<Map<String,Object>> around(long seed,RandomState state,ChunkGeneratorStructureState structState,List<Feature> parsed,int x,int z,JsonObject request,Job job) {
        var groups=new ArrayList<List<Map<String,Object>>>();var chosen=new Feature[parsed.size()];
        String biomeMode=request.has("biomeMode")?request.get("biomeMode").getAsString():"terrain";
        // Pass 1 tests structures with the generation-point check the game uses for /locate,
        // which avoids assembling pieces for seeds that fail another feature anyway.
        for(int i=0;i<parsed.size();i++) {
            var asked=parsed.get(i);
            // Conditions measured from another condition's matches are checked together with it.
            if(asked.near!=null){groups.add(List.of());continue;}
            // The condition itself first, then its alternatives in the order given; the first one that holds is reported.
            var options=new ArrayList<Feature>();options.add(asked);options.addAll(asked.or);
            List<Map<String,Object>> kept=null;
            for(var feature:options) {
                if(job!=null && !job.running.get())return null;
                var matches=new ArrayList<Map<String,Object>>();int taken=0;
                var at=frame(OVERWORLD,dimOf(feature),x,z);
                if(feature.kind.equals("structure"))taken=findStructures(feature,seed,state,structState,at[0],at[1],job,matches,feature.count,false,companions(feature,parsed,seed,state,structState,job,biomeMode));
                else {var b=findBiome(feature,seed,state,x,z,job,biomeMode);if(b!=null){matches.add(b);taken=1;}}
                if(feature.exclude?taken>0:taken<feature.count)continue;
                // An excluded feature has nothing to report.
                kept=feature.exclude?List.of():matches;chosen[i]=feature;break;
            }
            if(kept==null)return null;
            groups.add(kept);
        }
        // Pass 2 builds the structure starts, so every reported structure is still a confirmed start.
        for(int i=0;i<parsed.size();i++) {
            var feature=chosen[i]!=null?chosen[i]:parsed.get(i);
            if(!feature.kind.equals("structure")||feature.exclude||parsed.get(i).near!=null)continue;
            if(job!=null && !job.running.get())return null;
            var matches=new ArrayList<Map<String,Object>>();
            var at=frame(OVERWORLD,dimOf(feature),x,z);
            if(findStructures(feature,seed,state,structState,at[0],at[1],job,matches,feature.count,true,companions(feature,parsed,seed,state,structState,job,biomeMode))<feature.count)return null;
            groups.set(i,matches);
        }
        var found=new ArrayList<Map<String,Object>>();groups.forEach(found::addAll);
        int cluster=request.has("cluster")?request.get("cluster").getAsInt():0;
        // This tests the selected nearest matches; it does not exhaust all alternative clusters.
        // Nether matches count at the Overworld position their portal leads to; the End has no such position.
        java.util.function.ToIntBiFunction<Map<String,Object>,String> across=(m,axis)->((Number)m.get(axis)).intValue()*("nether".equals(m.get("dimension"))?8:1);
        if(cluster>0)for(var a:found)for(var b:found) {
            if("end".equals(a.get("dimension"))||"end".equals(b.get("dimension")))continue;
            if(Math.hypot(across.applyAsInt(a,"x")-across.applyAsInt(b,"x"),across.applyAsInt(a,"z")-across.applyAsInt(b,"z"))>cluster)return null;
        }
        return found;
    }
    // Gate on one necessary positive root condition. Never prune on exclusions,
    // dependent conditions, biome samples, or unsupported placement types.
    static Feature spawnGate(List<Feature> features) {
        return features.stream().filter(f->f.kind.equals("structure") && !Decorations.handles(f.key) && dimOf(f)==OVERWORLD && !f.exclude && f.near==null && f.or.isEmpty() && f.radius<=256)
            .filter(f->set(f.key).placement() instanceof RandomSpreadStructurePlacement p && p.spacing()>=32)
            .min(Comparator.comparingDouble(f->(double)f.radius/((RandomSpreadStructurePlacement)set(f.key).placement()).spacing())).orElse(null);
    }
    static java.util.function.Predicate<ChunkPos> placementGate(Feature f,long seed,int cx,int cz) {
        var placement=(RandomSpreadStructurePlacement)set(f.key).placement();
        int margin=512+8+f.radius;var offset=placement.locateOffset();int spacing=placement.spacing();
        int minX=Math.floorDiv(Math.floorDiv(cx-margin-offset.getX(),16),spacing),maxX=Math.floorDiv(Math.floorDiv(cx+margin-offset.getX(),16),spacing);
        int minZ=Math.floorDiv(Math.floorDiv(cz-margin-offset.getZ(),16),spacing),maxZ=Math.floorDiv(Math.floorDiv(cz+margin-offset.getZ(),16),spacing);
        var positions=new ArrayList<BlockPos>();
        for(int rx=minX;rx<=maxX;rx++)for(int rz=minZ;rz<=maxZ;rz++)positions.add(placement.getLocatePos(placement.getPotentialStructureChunk(seed,rx*spacing,rz*spacing)));
        return origin->{int count=0;for(var pos:positions){double distance=Math.hypot((double)pos.getX()-origin.getMiddleBlockX(),(double)pos.getZ()-origin.getMiddleBlockZ());if(distance>=f.minRadius && distance<=f.radius && ++count>=f.count)return true;}return false;};
    }
    static Map<String,Object> found(Feature f,BlockPos pos,int x,int z,String detail,String confidence) {
        return Map.of("kind",f.kind,"key",f.key,"x",pos.getX(),"y",pos.getY(),"z",pos.getZ(),"distance",Math.round(Math.hypot(pos.getX()-x,pos.getZ()-z)),"detail",detail,"confidence",confidence);
    }
    static StructureSet set(String key) { var holder=sets.get(key);if(holder==null)throw new IllegalArgumentException("Unknown structure: "+key);return holder.value(); }
    // Read the game's placement from the generated piece, rather than guessing from Y or biome.
    // Each placement option uses the original set and weighted selection; filter only after selection.
    static boolean portalMatches(String key,Start hit,StructureSet set,long seed,RandomState state,ChunkGeneratorStructureState structState,Climate.Sampler climate,ChunkPos chunk) {
        boolean huge=key.equals("huge_ruined_portals")||key.startsWith("huge_ruined_portals_");
        String family=huge?"huge_ruined_portals":"ruined_portals";
        if(huge||key.startsWith("ruined_portals_")&&!variantDetails.containsKey(key)) {
            if(hit.start==null)hit=startAt(dimOf(key),set,seed,state,structState,climate,chunk,true);
            if(hit==null||huge&&!hugePortal(hit))return false;
        }
        if(variantDetails.containsKey(key))return variantDetails.get(key).equals(hit.detail());
        return !key.startsWith(family+"_")||key.equals(family+"_"+portalPlacement(hit).getSerializedName());
    }
    static CompoundTag portalTag(Start hit) {
        for(var piece:hit.start.getPieces())if(piece instanceof RuinedPortalPiece)
            return piece.createTag(pieceContext);
        throw new IllegalStateException("Ruined portal start has no portal piece");
    }
    static RuinedPortalPiece.VerticalPlacement portalPlacement(Start hit) {
        return portalTag(hit).read("VerticalPlacement",RuinedPortalPiece.VerticalPlacement.CODEC).orElseThrow();
    }
    static boolean hugePortal(Start hit) {
        return Identifier.parse(portalTag(hit).getStringOr("Template","")).getPath().startsWith("ruined_portal/giant_portal_");
    }
    // What only a built start can tell about a structure, beyond its type:
    // a village's town centre comes from the zombie pools in an abandoned village; an igloo with a basement has the
    // ladder and laboratory as extra pieces; an ocean ruin that is a cluster has its smaller ruins as extra ones.
    // The house players call the blacksmith is the weaponsmith: the forge with the loot chest. Not every village has one.
    static boolean blacksmith(Start hit) {
        for(var piece:hit.start.getPieces())if(piece instanceof PoolElementStructurePiece house&&house.getElement().toString().contains("weaponsmith"))return true;
        return false;
    }
    static boolean zombieVillage(Start hit) { return hit.start.getPieces().get(0) instanceof PoolElementStructurePiece centre&&centre.getElement().toString().contains("/zombie/"); }
    static int ruinCount(Start hit) { return hit.start.getPieces().size()/(hit.detail().endsWith("cold")?3:1); }
    // The value a condition's "templates" filter is matched against, for the families listed in structureTemplates.
    static String templateOf(StructureSet set,Start hit) {
        if(set==set("villages"))return zombieVillage(hit)?"abandoned":"inhabited";
        if(set==set("igloos"))return hit.start.getPieces().size()>1?"basement":"no_basement";
        if(set==set("ocean_ruins"))return ruinCount(hit)>1?"cluster":"single";
        if(set==set("bastion_remnants"))return bastionKind(hit);
        if(set==set("end_cities"))return endShip(hit)?"ship":"no_ship";
        return shipwreckTemplate(hit);
    }
    // A bastion is one of four kinds, chosen with its first piece. An end city has a ship or not, as one of its pieces.
    static String bastionKind(Start hit) {
        String first=hit.start.getPieces().get(0) instanceof PoolElementStructurePiece piece?piece.getElement().toString():"";
        return first.contains("bastion/units/")?"housing":first.contains("bastion/hoglin_stable/")?"stables":first.contains("bastion/treasure/")?"treasure":first.contains("bastion/bridge/")?"bridge":"";
    }
    static boolean endShip(Start hit) {
        for(var piece:hit.start.getPieces())if(piece instanceof TemplateStructurePiece&&piece.createTag(pieceContext).getStringOr("Template","").endsWith("ship"))return true;
        return false;
    }
    static void builtFacts(Map<String,Object> result,Start hit,StructureSet set) {
        if(hit.start==null)return;
        var pieces=hit.start.getPieces();
        if(set==set("villages")){result.put("zombie",zombieVillage(hit));result.put("blacksmith",blacksmith(hit));}
        else if(set==set("igloos"))result.put("basement",pieces.size()>1);
        // A cold ruin is three overlaid pieces (stone brick, cracked, mossy); a warm one is a single piece.
        else if(set==set("ocean_ruins"))result.put("ruins",ruinCount(hit));
        else if(set==set("bastion_remnants")&&hit.detail().equals("bastion_remnant"))result.put("bastion",bastionKind(hit));
        else if(set==set("end_cities"))result.put("ship",endShip(hit));
    }
    static void portalFacts(Map<String,Object> result,Start hit) {
        var tag=portalTag(hit);String template=Identifier.parse(tag.getStringOr("Template","")).getPath();
        result.put("portalTemplate",template);
        result.put("portalSize",template.startsWith("ruined_portal/giant_portal_")?"huge":"regular");
        result.put("placement",tag.read("VerticalPlacement",RuinedPortalPiece.VerticalPlacement.CODEC).orElseThrow().getSerializedName());
    }
    static String shipwreckTemplate(Start hit) {
        for(var piece:hit.start.getPieces())if(piece instanceof ShipwreckPieces.ShipwreckPiece)
            return Identifier.parse(piece.createTag(pieceContext).getStringOr("Template","")).getPath();
        throw new IllegalStateException("Shipwreck start has no shipwreck piece");
    }
    // Every chunk the placement could use in the chunk rectangle, produced lazily; ring positions ignore the rectangle.
    static Stream<ChunkPos> candidates(StructurePlacement placement,long seed,ChunkGeneratorStructureState structState,int minX,int maxX,int minZ,int maxZ) {
        if(placement instanceof ConcentricRingsStructurePlacement rings)return structState.getRingPositionsFor(rings).stream();
        if(placement instanceof RandomSpreadStructurePlacement spread) {
            int s=spread.spacing();
            return IntStream.rangeClosed(Math.floorDiv(minX,s),Math.floorDiv(maxX,s)).boxed().flatMap(rx->IntStream.rangeClosed(Math.floorDiv(minZ,s),Math.floorDiv(maxZ,s)).mapToObj(rz->spread.getPotentialStructureChunk(seed,rx*s,rz*s)));
        }
        return IntStream.rangeClosed(minX,maxX).boxed().flatMap(cx->IntStream.rangeClosed(minZ,maxZ).mapToObj(cz->new ChunkPos(cx,cz)));
    }
    record Start(Holder<Structure> structure,int y,StructureStart start) {
        String detail() { return structure.unwrapKey().orElseThrow().identifier().getPath(); }
    }
    // The game's weighted choice among a set's structures for one chunk. confirm=false stops at a valid generation point
    // (y is that point's); confirm=true also builds the start and requires pieces (y is the bounding box minimum).
    static Start startAt(StructureSet set,long seed,RandomState state,ChunkGeneratorStructureState structState,Climate.Sampler climate,ChunkPos c,boolean confirm) { return startAt(OVERWORLD,set,seed,state,structState,climate,c,confirm); }
    // state, structState and climate must be the given dimension's.
    static Start startAt(Dim dim,StructureSet set,long seed,RandomState state,ChunkGeneratorStructureState structState,Climate.Sampler climate,ChunkPos c,boolean confirm) {
        if(!set.placement().isStructureChunk(structState,c.x(),c.z()))return null;
        var entries=new ArrayList<>(set.structures());
        var random=new WorldgenRandom(new LegacyRandomSource(0));random.setLargeFeatureSeed(seed,c.x(),c.z());
        int total=entries.stream().mapToInt(StructureSet.StructureSelectionEntry::weight).sum();
        while(!entries.isEmpty()) {
            int pick=entries.size()==1?0:random.nextInt(total),index=0;
            if(entries.size()>1)for(;index<entries.size()-1;index++){pick-=entries.get(index).weight();if(pick<0)break;}
            var entry=entries.remove(index);total-=entry.weight();var structure=entry.structure().value();
            var context=new Structure.GenerationContext(access,dim.generator,dim.generator.getBiomeSource(),climate,state,templates,seed,c,dim.heights,structure.biomes()::contains);
            if(structure instanceof OceanMonumentStructure&&!monumentPossible(context))continue;
            var point=structure.findValidGenerationPoint(context);
            if(point.isEmpty())continue;
            if(!confirm)return new Start(entry.structure(),point.get().position().getY(),null);
            StructureStart start;
            // The game assembles stronghold pieces through static fields of StrongholdPieces, so only one thread may build
            // a stronghold at a time; every other structure locks nothing shared.
            synchronized(structure instanceof StrongholdStructure?StrongholdPieces.class:context) { start=structure.generate(entry.structure(),dim.level,access,dim.generator,dim.generator.getBiomeSource(),climate,state,templates,seed,c,0,dim.heights,structure.biomes()::contains); }
            if(start.isValid())return new Start(entry.structure(),start.getBoundingBox().minY(),start);
        }
        return null;
    }
    // The monument check reads every biome cell of a 59-block cube (about 13 ms) before testing any of them.
    // Testing 27 of those same cells first rejects nearly every chunk that would fail, without changing a verdict.
    static boolean monumentPossible(Structure.GenerationContext context) {
        int x=context.chunkPos().getBlockX(9),y=generator.getSeaLevel(),z=context.chunkPos().getBlockZ(9);
        for(int dx=-29;dx<=29;dx+=29)for(int dy=-29;dy<=29;dy+=29)for(int dz=-29;dz<=29;dz+=29)
            if(!context.noiseBiomeResolver().getNoiseBiome(QuartPos.fromBlock(x+dx),QuartPos.fromBlock(y+dy),QuartPos.fromBlock(z+dz)).is(BiomeTags.REQUIRED_OCEAN_MONUMENT_SURROUNDING))return false;
        return true;
    }
    // The conditions measured from `parent`, as one check around a parent match at pos. It returns the matches to report
    // with that parent (each tagged with the parent it was measured from), or null when a condition fails there.
    static BiFunction<BlockPos,Boolean,List<Map<String,Object>>> companions(Feature parent,List<Feature> all,long seed,RandomState state,ChunkGeneratorStructureState structState,Job job,String biomeMode) {
        var deps=parent.id==null?List.<Feature>of():all.stream().filter(d->parent.id.equals(d.near)).toList();
        if(deps.isEmpty())return null;
        return (pos,confirm)->{
            var reported=new ArrayList<Map<String,Object>>();
            for(var d:deps) {
                var matches=new ArrayList<Map<String,Object>>();
                // A condition on the parent's own type must not count the parent itself.
                boolean same=d.kind.equals("structure")&&(Decorations.handles(d.key)||Decorations.handles(parent.key)?d.key.equals(parent.key):set(d.key)==set(parent.key));
                var at=frame(dimOf(parent),dimOf(d),pos.getX(),pos.getZ());
                if(d.kind.equals("structure"))findStructures(d,seed,state,structState,at[0],at[1],job,matches,d.count+(same?1:0),confirm&&!d.exclude,null);
                else {var b=findBiome(d,seed,state,at[0],at[1],job,biomeMode);if(b!=null)matches.add(b);}
                if(same)matches.removeIf(m->((Number)m.get("x")).intValue()==pos.getX()&&((Number)m.get("z")).intValue()==pos.getZ());
                if(d.exclude?!matches.isEmpty():matches.size()<d.count)return null;
                if(!d.exclude)for(var m:matches.subList(0,d.count)){var linked=new LinkedHashMap<>(m);linked.put("near",Map.of("key",parent.key,"x",pos.getX(),"z",pos.getZ()));reported.add(linked);}
            }
            return reported;
        };
    }
    // Adds matches to out, nearest first, until `limit` of them are found, and returns how many that was.
    // With companions, a match only counts where they hold too, and their matches are reported straight after it.
    // {left, top, right, bottom} in blocks (right and bottom exclusive): when set, only structures located inside count.
    static final ThreadLocal<int[]> ONLY_INSIDE=new ThreadLocal<>();
    static int findStructures(Feature f,long seed,RandomState state,ChunkGeneratorStructureState structState,int x,int z,Job job,List<Map<String,Object>> out,int limit,boolean confirm,BiFunction<BlockPos,Boolean,List<Map<String,Object>>> companions) {
        // Dungeons and geodes are not structures; the game places them while decorating a chunk, so that is predicted.
        if(Decorations.handles(f.key))return Decorations.find(f,seed,state,x,z,()->job==null||job.running.get(),out,limit,confirm,companions);
        var set=set(f.key); var placement=set.placement();
        // x and z are in the structure's own dimension; so are the positions reported.
        var dim=dimOf(f.key);
        if(dim!=OVERWORLD){var realm=realm(dim,seed);state=realm.state;structState=realm.structures;}
        int minX=Math.floorDiv(x-f.radius-32,16),maxX=Math.floorDiv(x+f.radius+32,16),minZ=Math.floorDiv(z-f.radius-32,16),maxZ=Math.floorDiv(z+f.radius+32,16);
        ToDoubleFunction<ChunkPos> distance=c->Math.hypot(placement.getLocatePos(c).getX()-x,placement.getLocatePos(c).getZ()-z);
        int[] box=ONLY_INSIDE.get();
        var candidates=candidates(placement,seed,structState,minX,maxX,minZ,maxZ).filter(c->{double d=distance.applyAsDouble(c);return d>=f.minRadius&&d<=f.radius;})
            .filter(c->{if(box==null)return true;var at=placement.getLocatePos(c);return at.getX()>=box[0]&&at.getZ()>=box[1]&&at.getX()<box[2]&&at.getZ()<box[3];}).sorted(Comparator.comparingDouble(distance)).toList();
        var climate=state.createClimateSampler(SamplerContext.EMPTY_UNCACHED);
        // A type read from the built structure (abandoned, blacksmith, a ship's template) costs a build for every
        // candidate. A count that the generation points alone cannot reach is refused before anything is built.
        if(!f.templates.isEmpty()||!f.placements.isEmpty()) {
            int needed=Math.min(limit,f.count),possible=0;
            for(var c:candidates) {
                if(possible>=needed||job!=null&&!job.running.get())break;
                var point=startAt(dim,set,seed,state,structState,climate,c,false);
                if(point!=null&&(f.variants.isEmpty()||f.variants.contains(point.detail())))possible++;
            }
            if(possible<needed)return 0;
        }
        int taken=0;
        for(var c:candidates) {
            if(taken>=limit||job!=null && !job.running.get())return taken;
            var hit=startAt(dim,set,seed,state,structState,climate,c,confirm&&companions==null);
            // Subcategories are alternatives within a family. Both filters apply to this same start.
            if(hit==null||!f.variants.isEmpty()&&!f.variants.contains(hit.detail()))continue;
            if(!f.templates.isEmpty()) {
                if(hit.start==null)hit=startAt(dim,set,seed,state,structState,climate,c,true);
                if(hit==null||!f.templates.contains(templateOf(set,hit)))continue;
            }
            Map<String,Object> shipPlacement=null;
            if(!f.placements.isEmpty()) {
                if(hit.start==null)hit=startAt(dim,set,seed,state,structState,climate,c,true);
                if(hit==null)continue;
                String placementName;
                if(set==set("shipwrecks")){shipPlacement=ShipwreckPlacement.facts(hit,state);placementName=(String)shipPlacement.get("placement");}
                else if(set==set("villages"))placementName=blacksmith(hit)?"blacksmith":"no_blacksmith";
                else placementName=portalPlacement(hit).getSerializedName();
                if(!f.placements.contains(placementName))continue;
            }
            if(hit==null||!portalMatches(f.key,hit,set,seed,state,structState,climate,c))continue;
            var pos=placement.getLocatePos(c);
            List<Map<String,Object>> extra=List.of();
            if(companions!=null) {
                // Cheap checks around the match come before anything is built.
                if((extra=companions.apply(pos,false))==null)continue;
                if(confirm&&((hit=startAt(dim,set,seed,state,structState,climate,c,true))==null||(extra=companions.apply(pos,true))==null))continue;
            }
            var match=new LinkedHashMap<>(found(f,new BlockPos(pos.getX(),hit.y,pos.getZ()),x,z,hit.detail(),confirm?"Snapshot structure start confirmed":"Snapshot generation point confirmed"));
            if(hit.start!=null&&set==set("ruined_portals"))portalFacts(match,hit);
            if(hit.start!=null&&set==set("shipwrecks"))match.put("shipwreckTemplate",shipwreckTemplate(hit));
            if(shipPlacement!=null)match.putAll(shipPlacement);
            builtFacts(match,hit,set);
            if(dim!=OVERWORLD)match.put("dimension",dim.name);
            out.add(match);
            out.addAll(extra);taken++;
        }
        return taken;
    }
    static boolean is(Holder<Biome> biome,String key) { return biome.unwrapKey().orElseThrow().identifier().getPath().equals(key); }
    // mode: "terrain" prefilters each sample with the router's cheap surface estimate, "fast" tests Y=64 only,
    // "exhaustive" computes the terrain column at every sample. Every returned point is confirmed on the real column.
    // The points a biome search looks at around its centre: every 32 blocks within the radius, nearest first.
    static List<int[]> biomeSamples(int radius) {
        return biomeOffsets.computeIfAbsent(radius,r->{var list=new ArrayList<int[]>();for(int dx=-r/32;dx<=r/32;dx++)for(int dz=-r/32;dz<=r/32;dz++)if(Math.hypot(dx*32,dz*32)<=r)list.add(new int[]{dx*32,dz*32});list.sort(Comparator.comparingDouble(a->Math.hypot(a[0],a[1])));return list;});
    }
    // A quart height well above any terrain, where the biome source gives the surface biome of a column.
    static final int ABOVE_SURFACE=Math.floorDiv(316,4);
    static Map<String,Object> findBiome(Feature f,long seed,RandomState state,int x,int z,Job job,String mode) {
        if(!biomeNames.containsKey(f.key))throw new IllegalArgumentException("Unknown biome: "+f.key);
        int y=(f.key.equals("deep_dark")||f.key.equals("lush_caves")||f.key.equals("dripstone_caves")||f.key.equals("sulfur_caves"))?-32:64;
        boolean cave=y==-32;
        var surface=generator.generatorSettings().value().noiseRouter().chunkSurfaceLevel();
        var resolver=generator.getBiomeSource().createUncachedResolver(state);
        var manager=new BiomeManager(resolver,BiomeManager.obfuscateSeed(seed));
        // A sampled scan can miss a tiny patch, but every returned biome point is real.
        var offsets=biomeSamples(f.radius);
        for(var offset:offsets) {
            if(job!=null && !job.running.get())return null;
            int bx=Math.floorDiv(x+offset[0],4)*4,bz=Math.floorDiv(z+offset[1],4)*4;
            double distance=Math.hypot(bx-x,bz-z);
            if(distance>f.radius||distance<f.minRadius)continue;
            int qx=Math.floorDiv(bx,4),qz=Math.floorDiv(bz,4);
            if(cave||mode.equals("fast")) { if(!is(resolver.getNoiseBiome(qx,Math.floorDiv(y,4),qz),f.key))continue; }
            else if(!mode.equals("exhaustive")) {
                // Above the surface first: one biome lookup instead of a surface estimate, which costs several times
                // more. Height enters the biome choice through depth alone, and above the surface depth ranks the
                // surface biomes as it does at the surface, so a point that fails here cannot pass below. Most
                // points of a search that finds nothing stop at this line.
                if(!is(resolver.getNoiseBiome(qx,ABOVE_SURFACE,qz),f.key))continue;
                // The estimate costs a fraction of a terrain column but reads low, so test it and one step above.
                int estimate=Math.round(state.sampleBlockValueUncached(surface,bx,0,bz));
                if(!is(resolver.getNoiseBiome(qx,Math.floorDiv(estimate,4),qz),f.key)&&!is(resolver.getNoiseBiome(qx,Math.floorDiv(estimate+12,4),qz),f.key))continue;
            }
            int confirmedY=cave?y:generator.getBaseColumn(bx,bz,heights,state).topBlockY();
            if(!is(manager.getBiome(bx,confirmedY,bz),f.key))continue;
            return found(f,new BlockPos(bx,confirmedY,bz),x,z,"32-block candidate scan; block-biome boundary and terrain height checked",cave?"Snapshot cave-biome point confirmed":"Snapshot surface-biome point confirmed");
        }
        return null;
    }
    // ---- Searching inside one seed -------------------------------------------
    // Every place in one world where the conditions hold, nearest to the origin first, out to the world border.
    // One condition is the anchor: the rarest structure asked for (or, with no structure, the first biome). The world
    // is cut into 4,096-block regions taken in a square spiral from the origin; every anchor in a region is tested
    // with the other conditions measured from it, exactly as a seed search measures them from the spawn.
    static volatile WorldJob world;
    static final int WORLD_EDGE=29999984;
    static final class WorldJob {
        static final int REGION=4096;
        final long id,seed;final JsonObject request;final Feature anchor;final List<Feature> others;final int threads,maxMatches,range;final long limit;
        // Structures that must be near, whose potential positions can rule a place out by arithmetic before anything costly runs.
        final List<Feature> structureGates;final boolean group;
        volatile int ox,oz;
        final AtomicBoolean running=new AtomicBoolean(true);final AtomicInteger matches=new AtomicInteger(),finished=new AtomicInteger();final LongAdder regions=new LongAdder();
        long next;final java.util.TreeSet<Long> unfinished=new java.util.TreeSet<>();
        // Places already reported by an earlier run of this search; a continued search looks again at the ring it stopped in.
        final Set<Long> known=ConcurrentHashMap.newKeySet();
        final long began=System.nanoTime();volatile String failure="";ScheduledFuture<?> reporting;
        synchronized long claim(){if(next>=limit)return -1;unfinished.add(next);return next++;}
        synchronized void complete(long index){unfinished.remove(index);}
        synchronized long checkpoint(){return unfinished.isEmpty()?next:unfinished.first();}
        // Ring 0 is the region around the origin; ring k is the square of regions k steps out, 8k of them.
        static int ring(long index){return (int)Math.ceil((Math.sqrt(index+1)-1)/2);}
        static int[] region(long index) {
            if(index==0)return new int[]{0,0};
            int k=ring(index),side=2*k;long offset=index-(2L*k-1)*(2L*k-1);int edge=(int)(offset/side),at=(int)(offset%side);
            return switch(edge){case 0->new int[]{k,-k+1+at};case 1->new int[]{k-1-at,k};case 2->new int[]{-k,k-1-at};default->new int[]{-k+1+at,-k};};
        }
        WorldJob(JsonObject r) {
            request=r;id=r.get("id").getAsLong();seed=Long.parseLong(r.get("seed").getAsString());threads=r.get("threads").getAsInt();maxMatches=r.get("maxMatches").getAsInt();range=r.get("range").getAsInt();
            var parsed=parseFeatures(r.getAsJsonArray("features"));
            if(parsed.stream().anyMatch(f->dimOf(f)!=OVERWORLD||f.or.stream().anyMatch(o->dimOf(o)!=OVERWORLD)))throw new IllegalArgumentException("Searching inside one seed covers the Overworld only. Nether and End structures can be used when searching many seeds.");
            if(parsed.stream().anyMatch(f->Decorations.handles(f.key)||f.or.stream().anyMatch(o->Decorations.handles(o.key))))throw new IllegalArgumentException("Dungeons and geodes are predicted chunk by chunk, which is too slow for a whole world. They can be used when searching many seeds.");
            // The anchor is the condition with the fewest candidates: ring structures (128 strongholds in a world), then the widest spacing.
            var roots=parsed.stream().filter(f->!f.exclude&&f.near==null&&f.or.isEmpty()).toList();
            ToDoubleFunction<Feature> rarity=f->set(f.key).placement() instanceof RandomSpreadStructurePlacement spread?spread.spacing():set(f.key).placement() instanceof ConcentricRingsStructurePlacement?1e9:1;
            // A structure asked for more than once is a group, and the group is what the places are; it takes precedence.
            anchor=roots.stream().filter(f->f.kind.equals("structure")).max(Comparator.comparingInt((Feature f)->f.count>1?1:0).thenComparingDouble(rarity)).orElseGet(()->roots.stream().filter(f->f.kind.equals("biome")).findFirst().orElse(null));
            if(anchor==null)throw new IllegalArgumentException("Searching a seed needs at least one structure or biome you want to find, without alternatives.");
            // Conditions that were measured from the anchor are now simply measured from the place being tested.
            var rest=new ArrayList<>(parsed.stream().filter(f->f!=anchor).map(f->anchor.id!=null&&anchor.id.equals(f.near)?new Feature(f.kind,f.key,f.radius,f.minRadius,f.count,f.exclude,f.id,null,f.variants,f.placements,f.templates,f.or):f).toList());
            // A count above one on the anchor asks for a group of the same structure: that many within its distance of
            // one of them. The group is an ordinary condition measured from the anchor, which counts itself.
            group=anchor.kind.equals("structure")&&anchor.count>1;
            if(group)rest.add(0,new Feature("structure",anchor.key,anchor.radius,0,anchor.count,false,null,null,anchor.variants,anchor.placements,anchor.templates,List.of()));
            others=List.copyOf(rest);
            var needed=others.stream().filter(f->!f.exclude&&f.near==null&&f.or.isEmpty()).toList();
            structureGates=needed.stream().filter(f->f.kind.equals("structure")&&set(f.key).placement() instanceof RandomSpreadStructurePlacement).toList();
            int rings=Math.min((int)Math.ceil((double)range/REGION)+1,(WORLD_EDGE*2)/REGION+2);
            limit=(2L*rings+1)*(2L*rings+1);
            int from=r.has("fromRing")?Math.max(0,r.get("fromRing").getAsInt()):0;
            next=from==0?0:(2L*from-1)*(2L*from-1);
            if(r.has("known"))for(var item:r.getAsJsonArray("known")){var at=item.getAsJsonArray();known.add(((long)at.get(0).getAsInt()<<32)^(at.get(1).getAsInt()&0xffffffffL));}
        }
        void report(boolean done) {
            long at=checkpoint();int complete=at>=limit?ring(limit-1)+1:ring(at);
            var progress=new LinkedHashMap<String,Object>(Map.of("type","worldprogress","id",id,"regions",regions.sum(),"ring",complete,"covered",Math.max(0,complete*REGION-REGION/2),"matches",Math.min(matches.get(),maxMatches),
                "seconds",(System.nanoTime()-began)/1e9,"running",!done,"error",failure,"complete",at>=limit));
            progress.put("anchor",Map.of("kind",anchor.kind,"key",anchor.key));progress.put("originX",ox);progress.put("originZ",oz);
            emit(progress);
        }
        void start() {
            reporting=PROGRESS.scheduleAtFixedRate(()->report(false),0,500,TimeUnit.MILLISECONDS);
            for(int i=0;i<threads;i++){var worker=new Thread(()->{
                try {
                    var state=RandomState.create(access.lookupOrThrow(Registries.NOISE),seed,generator.generatorSettings().value());
                    var origin=generator.getOrigin(state);
                    boolean custom=request.has("anchor")&&request.get("anchor").getAsString().equals("custom");
                    ox=custom?request.get("x").getAsInt():origin.getMiddleBlockX();oz=custom?request.get("z").getAsInt():origin.getMiddleBlockZ();
                    var structState=ChunkGeneratorStructureState.createForNormal(state,seed,origin,generator.getBiomeSource(),access.lookupOrThrow(Registries.STRUCTURE_SET));
                    while(running.get()){long index=claim();if(index<0)break;scan(index,state,structState);if(!running.get())break;regions.increment();complete(index);}
                }
                catch(Throwable e){failure=e.toString();running.set(false);e.printStackTrace(System.err);}
                finally{if(finished.incrementAndGet()==threads){running.set(false);reporting.cancel(false);report(true);}}
            },"world-worker-"+i);
            worker.setPriority(Thread.NORM_PRIORITY-1);worker.start();}
        }
        // Whether enough potential positions of a structure lie at the wanted distance: placement arithmetic only.
        boolean spaced(Feature f,ChunkGeneratorStructureState structState,int x,int z) {
            var placement=set(f.key).placement();
            int minX=Math.floorDiv(x-f.radius-32,16),maxX=Math.floorDiv(x+f.radius+32,16),minZ=Math.floorDiv(z-f.radius-32,16),maxZ=Math.floorDiv(z+f.radius+32,16);
            return candidates(placement,seed,structState,minX,maxX,minZ,maxZ).filter(c->{var at=placement.getLocatePos(c);double d=Math.hypot(at.getX()-x,at.getZ()-z);return d>=f.minRadius&&d<=f.radius;}).limit(f.count).count()>=f.count;
        }
        void scan(long index,RandomState state,ChunkGeneratorStructureState structState) {
            int[] cell=region(index);
            long left=(long)ox+(long)cell[0]*REGION-REGION/2,top=(long)oz+(long)cell[1]*REGION-REGION/2;
            // Regions wholly past the world border, or wholly beyond the range asked for, hold nothing to find.
            if(left>WORLD_EDGE||top>WORLD_EDGE||left+REGION<-WORLD_EDGE||top+REGION<-WORLD_EDGE)return;
            double nearX=Math.max(0,Math.max(left-ox,ox-(left+REGION))),nearZ=Math.max(0,Math.max(top-oz,oz-(top+REGION)));
            if(Math.hypot(nearX,nearZ)>range)return;
            // 1. Where the anchor could be, from placement alone. Nothing is checked against terrain yet.
            var spots=new ArrayList<int[]>();List<Map<String,Object>> biomeAnchors=null;
            if(anchor.kind.equals("structure")) {
                var placement=set(anchor.key).placement();
                candidates(placement,seed,structState,Math.floorDiv((int)left-32,16),Math.floorDiv((int)left+REGION+32,16),Math.floorDiv((int)top-32,16),Math.floorDiv((int)top+REGION+32,16)).forEach(c->{
                    var at=placement.getLocatePos(c);
                    if(at.getX()>=left&&at.getX()<left+REGION&&at.getZ()>=top&&at.getZ()<top+REGION)spots.add(new int[]{at.getX(),at.getZ()});
                });
            } else {
                biomeAnchors=new ArrayList<>();biomePlaces(state,(int)left,(int)top,biomeAnchors);
                for(var place:biomeAnchors)spots.add(new int[]{((Number)place.get("x")).intValue(),((Number)place.get("z")).intValue()});
            }
            spots.removeIf(at->Math.hypot(at[0]-ox,at[1]-oz)>range||Math.abs(at[0])>WORLD_EDGE||Math.abs(at[1])>WORLD_EDGE||known.contains(((long)at[0]<<32)^(at[1]&0xffffffffL)));
            // 2. Other structures that must be near: is there even a potential position at the right distance?
            for(var gate:structureGates)spots.removeIf(at->!spaced(gate,structState,at[0],at[1]));
            if(spots.isEmpty())return;
            // 3. What is left gets the real checks: the anchor's generation point, every condition around it, then the build.
            var exact=anchor.kind.equals("structure")?new Feature("structure",anchor.key,8,0,1,false,null,null,anchor.variants,anchor.placements,anchor.templates,List.of()):null;
            for(int i=0;i<spots.size();i++) {
                if(!running.get())return;
                int x=spots.get(i)[0],z=spots.get(i)[1];
                var scratch=new ArrayList<Map<String,Object>>();
                if(exact!=null&&findStructures(exact,seed,state,structState,x,z,null,scratch,1,false,null)<1)continue;
                var found=around(seed,state,structState,others,x,z,request,null);
                if(found==null)continue;
                if(request.has("landscape")) {
                    var land=Landscape.check(request.getAsJsonArray("landscape"),state,x,z,found,running::get);
                    if(land==null)continue;
                    found=new ArrayList<>(found);found.addAll(land);
                }
                var features=new ArrayList<Map<String,Object>>();
                if(group) {
                    // The group came back from the conditions, the anchor among its members. Each member finds the same
                    // group in turn, so it is reported once: from the member nearest the origin.
                    ToDoubleFunction<Map<String,Object>> fromOrigin=m->Math.hypot(((Number)m.get("x")).intValue()-ox,((Number)m.get("z")).intValue()-oz);
                    var members=found.stream().filter(m->anchor.key.equals(m.get("key"))&&!m.containsKey("near")).toList();
                    double own=Math.hypot(x-ox,z-oz);
                    if(members.stream().anyMatch(m->fromOrigin.applyAsDouble(m)<own-1e-9))continue;
                } else if(exact!=null) {
                    // The cheap generation-point check found it; the start is built now, as every reported structure is.
                    if(findStructures(exact,seed,state,structState,x,z,null,features,1,true,null)<1)continue;
                } else features.add(biomeAnchors.get(i<biomeAnchors.size()?i:0));
                features.addAll(found);
                int count=matches.incrementAndGet();
                if(count<=maxMatches)emit(Map.of("type","place","id",id,"data",Map.of("x",x,"y",features.get(0).get("y"),"z",z,"distance",Math.round(Math.hypot(x-ox,z-oz)),"features",features)));
                if(count>=maxMatches){running.set(false);return;}
            }
        }
        // A biome anchor: the region is sampled every 64 blocks on the biome source alone, and the sample nearest the
        // origin that the full check confirms stands for the whole region. One place per region is enough to go and look.
        void biomePlaces(RandomState state,int left,int top,List<Map<String,Object>> out) {
            var resolver=generator.getBiomeSource().createUncachedResolver(state);
            boolean cave=anchor.key.equals("deep_dark")||anchor.key.equals("lush_caves")||anchor.key.equals("dripstone_caves")||anchor.key.equals("sulfur_caves");
            int y=QuartPos.fromBlock(cave?-32:256);
            var hits=new ArrayList<int[]>();
            for(int bz=top;bz<top+REGION;bz+=64)for(int bx=left;bx<left+REGION;bx+=64)if(is(resolver.getNoiseBiome(QuartPos.fromBlock(bx),y,QuartPos.fromBlock(bz)),anchor.key))hits.add(new int[]{bx,bz});
            hits.sort(Comparator.comparingDouble(h->Math.hypot(h[0]-ox,h[1]-oz)));
            String mode=request.has("biomeMode")?request.get("biomeMode").getAsString():"terrain";
            var close=new Feature("biome",anchor.key,96,0,1,false,null,null,List.of(),List.of(),List.of(),List.of());
            for(int i=0;i<hits.size()&&i<6;i++) {
                var confirmed=findBiome(close,seed,state,hits.get(i)[0],hits.get(i)[1],null,mode);
                if(confirmed!=null){out.add(new LinkedHashMap<>(confirmed));return;}
            }
        }
    }
    static final class Job {
        final List<Feature> parsed;final Feature spawnGate;
        final JsonObject request;final JsonArray features;final long id,start,limit;final int threads,maxMatches;
        // When given, these seeds are checked instead of counting up from start (re-checking catalogued seeds).
        final long[] seeds;
        final AtomicBoolean running=new AtomicBoolean(true);final AtomicLong next=new AtomicLong();final LongAdder tested=new LongAdder();final AtomicInteger matches=new AtomicInteger(),finished=new AtomicInteger();
        final java.util.TreeSet<Long> unfinished=new java.util.TreeSet<>();
        synchronized long claim(){long index=next.get();if(index>=limit)return -1;unfinished.add(index);next.incrementAndGet();return index;}
        synchronized void complete(long index){unfinished.remove(index);}
        synchronized long checkpoint(){return unfinished.isEmpty()?next.get():unfinished.first();}
        final long began=System.nanoTime();volatile String failure="";ScheduledFuture<?> reporting;
        Job(JsonObject r){request=r;features=r.getAsJsonArray("features");parsed=parseFeatures(features);spawnGate=spawnGate(parsed);id=r.get("id").getAsLong();start=Long.parseLong(r.get("seed").getAsString());threads=r.get("threads").getAsInt();maxMatches=r.get("maxMatches").getAsInt();
            seeds=r.has("seeds")?StreamSupport.stream(r.getAsJsonArray("seeds").spliterator(),false).mapToLong(e->Long.parseLong(e.getAsString())).toArray():null;
            limit=seeds!=null?seeds.length:r.get("limit").getAsLong();}
        void report(boolean done){emit(Map.of("type","progress","id",id,"tested",tested.sum(),"matches",Math.min(matches.get(),maxMatches),"seconds",(System.nanoTime()-began)/1e9,"running",!done,"error",failure,"nextSeed",Long.toString(start+checkpoint())));}
        void start(){reporting=PROGRESS.scheduleAtFixedRate(()->report(false),0,500,TimeUnit.MILLISECONDS);for(int i=0;i<threads;i++){var worker=new Thread(()->{
            try {while(running.get()){long index=claim();if(index<0)break;var result=evaluate(seeds==null?start+index:seeds[(int)index],request,features,this);if(!running.get())break;tested.increment();complete(index);if(result!=null){int count=matches.incrementAndGet();if(count<=maxMatches)emit(Map.of("type","match","id",id,"data",result));if(count>=maxMatches)running.set(false);}}}
            catch(Throwable e){failure=e.toString();running.set(false);e.printStackTrace(System.err);}
            finally{if(finished.incrementAndGet()==threads){running.set(false);reporting.cancel(false);report(true);}}
        },"seed-worker-"+i);
        // Below the map workers: a search on every core must not make the map wait.
        worker.setPriority(Thread.NORM_PRIORITY-1);worker.start();}}
    }
}
