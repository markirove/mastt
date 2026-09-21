import type { Message } from '@mtcute/node'
import type { MessageContext } from '@mtcute/dispatcher'
import type { RoleMask, ResolvedRole, AdminRight } from './permissions.js'
import type { Collections } from '../services/mongo.js'
import type { CacheService } from '../services/redis.js'

export type CommandContextType =
  | 'private' | 'bot' | 'group' | 'supergroup' | 'channel'
  | 'any' | 'dev' | 'superuser'

export type CommandCategory =
  | 'general' | 'playback' | 'misc' | 'dev'

export type CommandContext = {
  msg: MessageContext
  tg: import('@mtcute/core/client.js').TelegramClient
  args: string[]
  rawArgs: string
  reply: Message | null
  role: ResolvedRole
  prefix: string
  context: CommandContextType
  db: Collections
  cache: CacheService
}

export type CommandHandler = (ctx: CommandContext) => Promise<void> | void

export type Command = {
  name: string
  aliases?: string[]
  description: string
  summary?: string
  usage: string
  category?: CommandCategory
  order?: number
  emoji?: string
  emojiId?: string

  roles: RoleMask[]
  permissions?: {
    chatAdminRights?: AdminRight[]
    custom?: (ctx: CommandContext) => Promise<boolean> | boolean
  }

  disabled?: boolean

  hidden?: boolean
  hiddenFromBelow?: boolean
  requiresReply?: boolean

  reply?: boolean

  contexts?: CommandContextType[] | 'any'

  handler: CommandHandler

  __context?: CommandContextType
  __filePath?: string
}

export { Role } from './permissions.js'
export type { RoleMask, ResolvedRole, AdminRight }

export function defineCommand(cmd: Command): Command {
  return cmd
}
