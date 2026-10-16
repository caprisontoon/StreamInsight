import { createChzzkCollector } from './chzzk.js';
import { createSoopCollector } from './soop.js';
import { createTwitchCollector } from './twitch.js';

const FACTORIES = { chzzk: createChzzkCollector, soop: createSoopCollector, twitch: createTwitchCollector };

export function createCollectors(cfg) {
  return cfg.platforms
    .filter((p) => FACTORIES[p])
    .map((p) => {
      const c = FACTORIES[p](cfg);
      if (c.enabled === undefined) c.enabled = true;
      return c;
    });
}
