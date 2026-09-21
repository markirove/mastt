import type { Collections } from '../services/mongo.js'
import type { CacheService } from '../services/redis.js'
import type { config } from '../config.js'

declare module '@mtcute/dispatcher' {
  interface DispatcherDependencies {
    db: Collections
    cache: CacheService
    config: typeof config
  }
}
