import { createChzzkCollector } from './chzzk.js';
import { createSoopCollector } from './soop.js';
import { createTwitchCollector } from './twitch.js';
import { createYoutubeCollector } from './youtube.js';

const FACTORIES = { chzzk: createChzzkCollector, soop: createSoopCollector, twitch: createTwitchCollector, youtube: createYoutubeCollector };

export function createCollectors(cfg, deps = {}) {
  return cfg.platforms
    .filter((p) => FACTORIES[p])
    .map((p) => {
      const c = FACTORIES[p](cfg, deps);
      if (c.enabled === undefined) c.enabled = true;
      return c;
    });
}
