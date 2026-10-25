import { defineConfig } from '@natsuneko-laboratory/archon';
import { csharp, kotlin, swift, typescript } from '@natsuneko-laboratory/archon/plugins';

export default defineConfig({
  input: './openapi/openapi.json',
  output: { path: './packages', clean: true },
  plugins: [
    typescript({ output: 'nodejs/src/generated', package: false }),
    swift({ output: 'swift/Generated', moduleName: 'CatalystAPI', package: false }),
    csharp({ output: 'dotnet/CatalystSharp/Generated', namespace: 'CatalystSharp.Api', package: false }),
    kotlin({ output: 'kotlin/src/generated/kotlin', packageName: 'com.natsuneko.catalyst.api', package: false }),
  ],
});
