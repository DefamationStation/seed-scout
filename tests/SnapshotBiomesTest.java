import java.util.*;
import com.google.gson.JsonParser;
import net.minecraft.core.registries.Registries;
import net.minecraft.world.level.biome.BiomeManager;
import net.minecraft.world.level.levelgen.RandomState;

/** Ice Caves must be searched underground in every search path, with real block-biome confirmation. */
public final class SnapshotBiomesTest {
    public static void main(String[] args) throws Exception {
        SeedEngine.initialize();
        if(!SeedEngine.biomeNames.containsKey("ice_caves"))throw new AssertionError("Ice Caves missing from native catalogue");
        var f=new SeedEngine.Feature("biome","ice_caves",1500,0,1,false,"ice",null,List.of(),List.of(),List.of(),List.of());
        Map<String,Object> hit=null;RandomState state=null;long seed=0;
        for(;seed<30;seed++) {
            state=RandomState.create(SeedEngine.access.lookupOrThrow(Registries.NOISE),seed,SeedEngine.generator.generatorSettings().value());
            hit=SeedEngine.findBiome(f,seed,state,0,0,null,"terrain");
            if(hit!=null)break;
        }
        if(hit==null)throw new AssertionError("No Ice Caves found across the fixture seeds");
        int x=((Number)hit.get("x")).intValue(),y=((Number)hit.get("y")).intValue(),z=((Number)hit.get("z")).intValue();
        var manager=new BiomeManager(SeedEngine.generator.getBiomeSource().createUncachedResolver(state),BiomeManager.obfuscateSeed(seed));
        if(y!=-32||!SeedEngine.is(manager.getBiome(x,y,z),"ice_caves"))throw new AssertionError("Search result is not a native underground Ice Caves point");
        for(String mode:List.of("terrain","fast","exhaustive"))if(SeedEngine.findBiome(f,seed,state,x,z,null,mode)==null)throw new AssertionError("Cave search failed in "+mode);
        var request=JsonParser.parseString("{\"id\":1,\"seed\":\""+seed+"\",\"threads\":1,\"maxMatches\":10,\"range\":4096,\"features\":[{\"kind\":\"biome\",\"key\":\"ice_caves\",\"radius\":1500}]} ").getAsJsonObject();
        var world=new SeedEngine.WorldJob(request);var found=new ArrayList<Map<String,Object>>();
        world.biomePlaces(state,Math.floorDiv(x,4096)*4096,Math.floorDiv(z,4096)*4096,found);
        if(found.isEmpty())throw new AssertionError("Single-seed cave anchor search found nothing in a region containing Ice Caves");
        for(var point:found)if(((Number)point.get("y")).intValue()!=-32||!SeedEngine.is(manager.getBiome(((Number)point.get("x")).intValue(),-32,((Number)point.get("z")).intValue()),"ice_caves"))throw new AssertionError("Single-seed result is not native Ice Caves");
        // Adding cave features changes decoration indexes: dungeon/geode placement must still use the native order.
        Decorations.chunk(seed,state,x>>4,z>>4,Set.of("dungeons","amethyst_geodes"));
        System.err.println("SNAPSHOT_BIOMES_PASS seed="+seed+" xyz="+x+","+y+","+z+" worldPlaces="+found.size());
        System.exit(0);
    }
}
