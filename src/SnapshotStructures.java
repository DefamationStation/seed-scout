import java.lang.reflect.*;
import java.util.Arrays;
import net.minecraft.core.*;
import net.minecraft.server.packs.resources.ResourceManager;
import net.minecraft.world.level.levelgen.structure.*;
import net.minecraft.world.level.levelgen.structure.pieces.StructurePieceSerializationContext;
import net.minecraft.world.level.levelgen.structure.templatesystem.StructureTemplateManager;

/** The two structure signatures changed in Snapshot 3. Keep older installed snapshots selectable too. */
final class SnapshotStructures {
    private SnapshotStructures() {}
    private static final Method GENERATE=Arrays.stream(Structure.class.getMethods())
        .filter(m->m.getName().equals("generate")&&(m.getParameterCount()==12||m.getParameterCount()==13))
        .findFirst().orElseThrow();

    static StructurePieceSerializationContext pieceContext(ResourceManager resources,RegistryAccess access,StructureTemplateManager templates) {
        try {
            try { return StructurePieceSerializationContext.class.getConstructor(RegistryAccess.class,StructureTemplateManager.class).newInstance(access,templates); }
            catch(NoSuchMethodException old) { return StructurePieceSerializationContext.class.getConstructor(ResourceManager.class,RegistryAccess.class,StructureTemplateManager.class).newInstance(resources,access,templates); }
        } catch(ReflectiveOperationException e) { throw new IllegalStateException("Unsupported structure serialization API",e); }
    }

    static StructureStart generate(Holder<Structure> holder,SeedEngine.Dim dim,Structure.GenerationContext context) {
        Object[] args=GENERATE.getParameterCount()==12
            ?new Object[]{holder,dim.level(),context.registryAccess(),context.chunkGenerator(),context.biomeSource(),context.climateSampler(),context.randomState(),context.structureTemplateManager(),context.seed(),context.chunkPos(),context.heightAccessor(),context.validBiome()}
            :new Object[]{holder,dim.level(),context.registryAccess(),context.chunkGenerator(),context.biomeSource(),context.climateSampler(),context.randomState(),context.structureTemplateManager(),context.seed(),context.chunkPos(),0,context.heightAccessor(),context.validBiome()};
        try { return (StructureStart)GENERATE.invoke(holder.value(),args); }
        catch(InvocationTargetException e) {
            if(e.getCause() instanceof RuntimeException cause)throw cause;
            if(e.getCause() instanceof Error cause)throw cause;
            throw new IllegalStateException("Structure generation failed",e.getCause());
        } catch(ReflectiveOperationException e) { throw new IllegalStateException("Unsupported structure generation API",e); }
    }
}
