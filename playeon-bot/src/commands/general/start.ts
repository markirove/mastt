import { defineCommand, Role } from '../../core/command.js'
import { groupStartKeyboard, groupStartText, startText, startKeyboard } from '../../lib/startCard.js'
import { renderHelpOverview } from '../../core/help.js'
import type { Collections } from '../../services/mongo.js'
import type { CacheService } from '../../services/redis.js'
import { isMediaForbidden } from '../../lib/tgErrors.js'

async function getBanner(db: Collections, cache: CacheService): Promise<string | null> {
  const cached = await cache.get<string>('settings:banner')
  if (cached) return cached
  const doc = await db.settings.findOne({ _id: 'global' })
  const id = doc?.bannerFileId ?? null
  if (id) await cache.set('settings:banner', id, 3600)
  return id
}

export default defineCommand({
  name: 'start',
  order: 8,
  emoji: '👋',
  emojiId: '5985478698722136468',
  description: 'Show the welcome screen with quick links.',
  usage: '/start',
  category: 'general',
  contexts: 'any',
  reply: true,
  roles: [Role.USER],

  handler: async (ctx) => {
    const { msg, tg, cache, db, logger, args, role } = ctx
    const user = msg.sender
    if (user.type !== 'user') return

    const now = new Date()
    await db.users.updateOne(
      { _id: String(user.id) },
      {
        $setOnInsert: { firstSeenAt: now },
        $set: {
          lastSeenAt: now,
          username: user.username ?? undefined,
          firstName: user.firstName ?? undefined,
          lastName: user.lastName ?? undefined,
        },
      },
      { upsert: true },
    )
    const startRes = await db.users.updateOne(
      { _id: String(user.id), startedAt: { $exists: false } },
      { $set: { startedAt: now } },
    )
    

    const payload = args[0]?.toLowerCase()
    if (payload === 'guide' || payload === 'help') {
      const page = renderHelpOverview(role, { id: msg.id, from: 'cmd' })
      await msg.answerText(page.text, { replyMarkup: page.replyMarkup, disableWebPreview: true })
      return
    }

    const bannerId = await getBanner(db, cache)

    const inGroup = msg.chat.type !== 'user'
    const text = inGroup ? groupStartText(user.firstName, user.id) : startText(user.firstName, user.id)
    const replyMarkup = inGroup ? groupStartKeyboard(String(msg.chat.id)) : startKeyboard(msg.id, user.id)

    /*
      The banner is a nicety; the message is the point.

      Plenty of groups switch media off for everyone, and there the photo send
      used to throw and the user got nothing at all - no welcome, no keyboard,
      for a command that had worked fine. Both halves are needed: the chat's
      own permissions answer before a request is spent when they are known,
      and the catch covers the rest, since a right can be missing per-bot or
      per-topic in ways `permissions` does not describe.
    */
    const sendPlain = () => msg.answerText(text, { replyMarkup, disableWebPreview: true })

    // narrowed inline: `permissions` lives on a chat, and a DM peer is a user
    const chatRefusesPhotos =
      msg.chat.type !== 'user' && msg.chat.permissions?.canSendPhotos === false

    if (!bannerId || chatRefusesPhotos) {
      await sendPlain()
      return
    }

    try {
      await tg.sendMedia(msg.chat.id, {
        type: 'photo',
        file: bannerId,
        caption: text,
      }, { replyMarkup })
    } catch (err) {
      if (!isMediaForbidden(err)) throw err
      await sendPlain()
    }
  },
})
