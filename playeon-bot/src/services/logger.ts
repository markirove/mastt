import { logBotJoinedChat } from './logs/botJoinedChat.js'
import { logBotLeftChat } from './logs/botLeftChat.js'
import { logPrefixChanged } from './logs/prefixChanged.js'
import { logSuperuserAdded } from './logs/superuserAdded.js'
import { logSuperuserRemoved } from './logs/superuserRemoved.js'
import { logTrackPlayed } from './logs/trackPlayed.js'
import { logCommandError } from './logs/commandError.js'

export type Logger = typeof logger

export const logger = {
  botJoinedChat: logBotJoinedChat,
  botLeftChat: logBotLeftChat,
  prefixChanged: logPrefixChanged,
  superuserAdded: logSuperuserAdded,
  superuserRemoved: logSuperuserRemoved,
  trackPlayed: logTrackPlayed,
  commandError: logCommandError,
}
