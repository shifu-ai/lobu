import {
  type ConfigureOptions,
  configureMemoryPlugin,
} from "./_lib/openclaw-cmd.js";

export async function memoryConfigureCommand(
  options: ConfigureOptions
): Promise<void> {
  await configureMemoryPlugin(options);
}
