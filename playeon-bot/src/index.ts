import { tg, dp, setBotInfo } from './client.js'
import { initMongo, collections } from './services/mongo.js'
import { initRedis, cache } from './services/redis.js'
import { config } from './config.js'
import { logger } from './services/logger.js'
import { loadCommands } from './core/loader.js'
import { registerHelpCallbacks } from './core/helpCallbacks.js'
import { registerChatJoinHandler } from './handlers/botJoinedChat.js'
import { registerMessageCounter } from './handlers/messageCounter.js'
import { registerLeaderboardCallbacks } from './lib/leaderboard.js'
import { registerAnalyticsCallbacks } from './lib/analyticsCard.js'
import { registerAdminListCallbacks } from './lib/adminLists.js'
import { registerRankCallbacks } from './lib/rankCard.js'
import { registerBotConversations } from './lib/botConversation.js'
import { startRoomServer, stopRoomServer } from './services/room/server.js'
import { roomManager } from './services/room/RoomManager.js'
import { registerRoomCards } from './services/room/roomCards.js'
import { registerRoomCallbacks } from './services/room/roomCallbacks.js'
import { registerInlineHandlers } from './services/room/inlineFlow.js'
import { registerQueueCallbacks } from './services/playback/queue.js'
import { registerRoomsView } from './lib/roomsView.js'
import { registerPingCallbacks } from './commands/general/ping.js'
import { registerBroadcastCallbacks } from './services/broadcast.js'
import { registerRecommendationCardCallbacks } from './services/playback/recommendationsCard.js'
import { registerAutoplayCallbacks } from './commands/playback/autoplay.js'
import { relayStatus } from './services/media/jiosaavn.js'

import { registerAiMessageHandler } from './handlers/aiMessageHandler.js'

/*
  Process-level safety net.

  A single floating promise rejection - a dead YouTube link surfacing from a
  speculative prefetch, a Telegram RPC that lost its `.catch()` - used to take
  the whole bot down until pm2 restarted it, which is minutes of silence. Log
  it loudly and keep serving. Only bail if they arrive in a tight loop, where a
  clean restart really is the better outcome.
*/
const crashes: number[] = []
function crashLooping(): boolean {
  const now = Date.now()
  while (crashes.length && now - crashes[0]! > 60_000) crashes.shift()
  crashes.push(now)
  return crashes.length >= 5
}

process.on('unhandledRejection', (reason) => {
  console.error('[safety] unhandledRejection:', reason)
  try { logger.commandError('unhandledRejection', reason, 0) } catch {}
})

process.on('uncaughtException', (err) => {
  console.error('[safety] uncaughtException:', err)
  try { logger.commandError('uncaughtException', err, 0) } catch {}
  if (crashLooping()) {
    console.error('[safety] 5 uncaught exceptions within 60s - exiting for a clean restart')
    process.exit(1)
  }
})

async function main() {
  await Promise.all([initMongo(), initRedis()])

  dp.inject({ db: collections, cache, logger, config })

  /*
    Handler exceptions have nowhere to propagate but the process. A raw
    `dp.onNewMessage` / `onChatMemberUpdate` handler throwing CHAT_WRITE_FORBIDDEN
    because a group muted the bot should be a logged non-event, not a crash -
    every handler already treats its side effects as best-effort.
  */
  dp.onError((err, update) => {
    console.error(`[dp] handler error on ${update.name}:`, err)
    try { logger.commandError(`dp:${update.name}`, err, 0) } catch {}
    return true
  })

  await loadCommands()
  registerHelpCallbacks()
  registerChatJoinHandler()
  registerMessageCounter()
  registerAiMessageHandler()
  registerLeaderboardCallbacks()
  registerAnalyticsCallbacks()
  registerAdminListCallbacks()
  registerRankCallbacks()
  registerBotConversations()
  registerQueueCallbacks()
  registerRoomsView()
  registerPingCallbacks()
  registerInlineHandlers()
  registerBroadcastCallbacks()
  registerRecommendationCardCallbacks()
  registerAutoplayCallbacks()

  const self = await tg.start({ botToken: config.botToken })

  setBotInfo({
    id: self.id,
    username: self.username ?? '',
    displayName: self.displayName,
  })

  roomManager.setGroupNotifier((groupId, text, keyboard) => {
    /*
      No preview on room notices.

      These carry a linked track title, and Telegram answers a link by pasting
      the whole YouTube card underneath - thumbnail, channel, description. The
      notice is two lines by design and the embed is four times its size.
    */
    void tg
      .sendText(Number(groupId), text, {
        ...(keyboard ? { replyMarkup: keyboard } : {}),
        disableWebPreview: true,
      })
      .catch(() => {})
  })
  registerRoomCards()
  registerRoomCallbacks()

  await startRoomServer()

  console.log(`[relay] JioSaavn search via ${relayStatus()}`)
  console.log(`[boot] running as @${self.username ?? self.id}${config.devMode ? ' (DEV MODE)' : ''}`)
}

let shuttingDown = false
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`[boot] ${signal} received, shutting down…`)
  await stopRoomServer().catch(() => {})
  process.exit(0)
}
process.once('SIGINT', () => void shutdown('SIGINT'))
process.once('SIGTERM', () => void shutdown('SIGTERM'))

main().catch(err => {
  console.error('[boot] fatal error:', err)
  process.exit(1)
})
