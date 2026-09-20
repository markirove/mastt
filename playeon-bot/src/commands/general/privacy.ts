import { md } from '@mtcute/markdown-parser'
import { defineCommand, Role } from '../../core/command.js'

const PRIVACY = md`**Privacy - what Playeon collects**

**The bot**
• **Your account basics** - Telegram user id, name and @username - to identify you, mention you, and power ranking.
• **Activity counts** - how many messages you send in groups (for levels & leaderboards) and when you were last active. Message *contents* are not stored.
• **Groups** - the id, title and member count of groups I'm added to, and who added me.
• **Playback** - timestamps of tracks played (for stats). Not tied to your identity.

**The mini-app (web room)**
• **Telegram login data** - the signed  Telegram sends, verified to confirm it's really you.
• **Room activity** - who's connected and what's playing, live, so the room stays in sync. It isn't kept after you leave.

**What I never do**
• No selling or sharing your data with third parties.
• No reading or storing your message contents.

Questions or a deletion request? Reach out via Support.`

export default defineCommand({
  name: 'privacy',
  order: 14,
  description: 'What data the bot and mini-app collect, and what they never do.',
  summary: 'See what data the bot and mini-app collect.',
  usage: '/privacy',
  category: 'general',
  contexts: 'any',
  reply: true,
  roles: [Role.USER],

  handler: async (ctx) => {
    await ctx.msg.answerText(PRIVACY, { disableWebPreview: true })
  },
})
