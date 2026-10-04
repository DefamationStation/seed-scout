import java.lang.reflect.Proxy;
import java.util.*;
import net.minecraft.core.BlockPos;
import net.minecraft.world.level.*;
import net.minecraft.world.level.levelgen.densityfunction.SamplerContext;
import net.minecraft.world.level.levelgen.structure.structures.ShipwreckPieces;
import net.minecraft.util.RandomSource;

/** Differential check: compare predicted heights with Minecraft's own postProcess on real base columns. */
public class ShipwreckPlacementTest {
    static final class PlacementReached extends RuntimeException {}
    static void check(boolean value,String message){if(!value)throw new AssertionError(message);}
    public static void main(String[] args)throws Exception {
        SeedEngine.initialize();int checked=0;
        for(long[] fixture:new long[][]{{139,2176,3856},{123,192,7056},{159,-1056,-3680},{168,-3552,3072},{5645,4064,1696}}) {
            long seed=fixture[0];int x=(int)fixture[1],z=(int)fixture[2];var state=SeedEngine.mapStructures(seed);var random=state.randomState();var set=SeedEngine.set("shipwrecks");
            var hit=SeedEngine.startAt(set,seed,random,state,random.createClimateSampler(SamplerContext.EMPTY_UNCACHED),new ChunkPos(x>>4,z>>4),true);
            check(hit!=null,"Missing fixture");var facts=ShipwreckPlacement.facts(hit,random);
            check(facts.get("placement").equals(seed==123?"submerged":seed==5645?"afloat":"surface"),"Wrong water placement: "+facts);
            check(seed==5645?(int)facts.get("groundedHullColumns")==0:(int)facts.get("groundedHullColumns")>0,"Wrong hull contact: "+facts);
            var world=(WorldGenLevel)Proxy.newProxyInstance(WorldGenLevel.class.getClassLoader(),new Class<?>[]{WorldGenLevel.class},(proxy,method,values)->{
                if(method.getName().equals("getMaxY"))return 319;
                if(method.getName().equals("getHeight"))return SeedEngine.generator.getBaseColumn((int)values[1],(int)values[2],SeedEngine.heights,random).findTopSolidBlockY()+1;
                // Stop at placement, after native height adjustment. No world or block writes are needed.
                throw new PlacementReached();
            });
            var piece=(ShipwreckPieces.ShipwreckPiece)hit.start().getPieces().get(0);
            try {piece.postProcess(world,null,SeedEngine.generator,RandomSource.create(0),hit.start().getBoundingBox(),new ChunkPos(x>>4,z>>4),new BlockPos(x,0,z));}
            catch(PlacementReached expected){}
            check(piece.createTag(SeedEngine.pieceContext).getBooleanOr("height_adjusted",false),"Did not reach native height adjustment");
            check(piece.templatePosition().getY()==(int)facts.get("shipY"),"Prediction differs from native postProcess: "+facts);
            check((int)facts.get("shipDeckY")==piece.templatePosition().getY()+4,"Main deck must include slab floors, not just planks");
            checked++;
        }
        System.out.println("Native shipwreck postProcess matched predictions for "+checked+" submerged/surface/afloat fixtures, including negative coordinates and rotations.");
    }
}
