import java.util.*;
import java.util.concurrent.ConcurrentHashMap;
import net.minecraft.core.*;
import net.minecraft.nbt.CompoundTag;
import net.minecraft.world.level.levelgen.*;
import net.minecraft.world.level.levelgen.densityfunction.DensityVolume;
import net.minecraft.world.level.levelgen.structure.structures.ShipwreckPieces;
import net.minecraft.world.level.levelgen.structure.templatesystem.*;

/** Water placement predicted from native ship geometry and base terrain, without generating a world save. */
final class ShipwreckPlacement {
    static final List<String> OPTIONS=List.of("afloat","surface","submerged","beached");
    record Shape(int deck,int hullTop,List<BlockPos> keel) {}
    static final Map<String,Shape> SHAPES=new ConcurrentHashMap<>();
    static Shape shape(String name,StructureTemplate template) {
        return SHAPES.computeIfAbsent(name,k->{
            var tag=template.save(new CompoundTag());var palettes=tag.getListOrEmpty("palettes");
            var palette=palettes.isEmpty()?tag.getListOrEmpty("palette"):palettes.getListOrEmpty(0);
            var levels=new TreeMap<Integer,Integer>();var bottoms=new HashMap<Long,BlockPos>();var physical=new ArrayList<BlockPos>();int top=0;
            for(var block:tag.getListOrEmpty("blocks").compoundStream().toList()) {
                var material=palette.getCompoundOrEmpty(block.getIntOr("state",0));
                String id=material.getStringOr("id",material.getStringOr("Name",""));
                var p=block.getListOrEmpty("pos");var pos=new BlockPos(p.getIntOr(0,0),p.getIntOr(1,0),p.getIntOr(2,0));
                if(!id.isEmpty()&&!id.endsWith(":air")&&!id.endsWith(":structure_block")&&!id.endsWith(":structure_void"))physical.add(pos);
                // Masts and rigging cannot turn a sunken hull into a surface ship.
                if(!id.endsWith("_planks")&&!id.endsWith("_stairs")&&!id.endsWith("_slab"))continue;
                if(id.endsWith("_planks")||id.endsWith("_slab"))levels.merge(pos.getY(),1,Integer::sum);
                top=Math.max(top,pos.getY());
            }
            for(var pos:physical)if(pos.getY()<=top) {
                long column=((long)pos.getX()<<32)|(pos.getZ()&0xffffffffL);
                bottoms.merge(column,pos,(a,b)->a.getY()<b.getY()?a:b);
            }
            if(levels.isEmpty()||bottoms.isEmpty())throw new IllegalStateException("Ship template has no hull: "+name);
            int deck=levels.entrySet().stream().max(Map.Entry.<Integer,Integer>comparingByValue().thenComparing(Map.Entry.comparingByKey())).orElseThrow().getKey();
            return new Shape(deck,top,List.copyOf(bottoms.values()));
        });
    }
    static Map<String,Object> facts(SeedEngine.Start hit,RandomState state) {
        var piece=(ShipwreckPieces.ShipwreckPiece)hit.start().getPieces().get(0);
        String template=SeedEngine.shipwreckTemplate(hit);
        if(hit.detail().equals("shipwreck_beached"))return Map.of("placement","beached","placementAccuracy","Native beached shipwreck type");
        var shape=shape(template,piece.template());var origin=piece.templatePosition();var size=piece.template().getSize();
        var transformed=shape.keel.stream().map(p->StructureTemplate.calculateRelativePosition(piece.placeSettings(),p).offset(origin.getX(),0,origin.getZ())).toList();
        int minX=Math.min(origin.getX(),transformed.stream().mapToInt(BlockPos::getX).min().orElseThrow()),minZ=Math.min(origin.getZ(),transformed.stream().mapToInt(BlockPos::getZ).min().orElseThrow());
        int maxX=Math.max(origin.getX()+size.getX()-1,transformed.stream().mapToInt(BlockPos::getX).max().orElseThrow()),maxZ=Math.max(origin.getZ()+size.getZ()-1,transformed.stream().mapToInt(BlockPos::getZ).max().orElseThrow());
        var noise=SeedEngine.generator.generatorSettings().value().noiseSettings().clampToHeightAccessor(SeedEngine.heights);
        int spanX=maxX-minX+1,spanZ=maxZ-minZ+1;var columns=new SeedEngine.Surface[spanX*spanZ];
        try(var chunk=SeedEngine.noiseChunk(state,new DensityVolume(spanX,noise.height(),spanZ,minX,noise.minY(),minZ),true)) {
            for(int z=0;z<spanZ;z++)for(int x=0;x<spanX;x++)columns[z*spanX+x]=SeedEngine.Surface.of(chunk.prepareColumn(x,z));
        }
        // ShipwreckPiece.postProcess averages OCEAN_FLOOR_WG over the *unrotated* rectangle at templatePosition.
        // Preserve that native behaviour; using the rotated bounding box would predict a different height near shores.
        int total=0;for(int z=0;z<size.getZ();z++)for(int x=0;x<size.getX();x++)total+=columns[(origin.getZ()+z-minZ)*spanX+origin.getX()+x-minX].ground()+1;
        int y=piece.isTooBigToFitInWorldGenRegion()?origin.getY():total/(size.getX()*size.getZ());
        int water=0,grounded=0,minClearance=Integer.MAX_VALUE;var waterLevels=new ArrayList<Integer>();
        int bottom=Integer.MAX_VALUE;
        for(var p:transformed) {
            var column=columns[(p.getZ()-minZ)*spanX+p.getX()-minX];int keelY=y+p.getY();bottom=Math.min(bottom,keelY);
            int clearance=keelY-column.ground()-1;minClearance=Math.min(minClearance,clearance);if(clearance<=0)grounded++;
            if(column.water()){water++;waterLevels.add(column.top());}
        }
        waterLevels.sort(Integer::compareTo);int waterY=waterLevels.isEmpty()?SeedEngine.generator.getSeaLevel()-1:waterLevels.get(waterLevels.size()/2);
        int deckY=y+shape.deck;double coverage=(double)water/transformed.size();
        boolean upright=template.contains("/with_mast")||template.contains("/rightsideup_");
        // Slab decks can lie below the top of a water block, so require the deck block above water's top block.
        String placement=coverage<.8?"beached":deckY<=waterY?"submerged":"surface";
        // Afloat means a clear keel over water, a dry main deck, and a hull at the waterline, not a mast above water
        // or a ship perched high in the air. No seabed contact is allowed at any column of the native hull.
        if(placement.equals("surface")&&upright&&coverage>=.95&&grounded==0&&bottom>=waterY-6&&bottom<=waterY+1)placement="afloat";
        var facts=new LinkedHashMap<String,Object>();
        var box=piece.template().getBoundingBox(piece.placeSettings(),new BlockPos(origin.getX(),y,origin.getZ()));
        facts.put("shipBox",Map.of("minX",box.minX(),"minY",box.minY(),"minZ",box.minZ(),"maxX",box.maxX(),"maxY",box.maxY(),"maxZ",box.maxZ()));
        facts.put("placement",placement);facts.put("shipY",y);facts.put("shipKeelY",bottom);facts.put("shipDeckY",deckY);facts.put("shipHullTopY",y+shape.hullTop);facts.put("waterY",waterY);
        facts.put("hullWaterCoverage",Math.round(coverage*100));facts.put("groundedHullColumns",grounded);facts.put("keelClearance",minClearance);
        facts.put("placementAccuracy","Native placement formula on base terrain; ice, terrain decoration and other structures may alter the final world");
        return facts;
    }
}
