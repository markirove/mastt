import { emojiTag, TEXT_SKIP_EMOJI_ID, TEXT_PAUSE_EMOJI_ID, TEXT_PLAY_EMOJI_ID } from '../../lib/emoji.js'
import { randomUUID } from 'node:crypto'
import { md } from '@mtcute/markdown-parser'
import { BotKeyboard } from '@mtcute/node'
import type { WebSocket } from 'ws'
import { config } from '../../config.js'
import { joinRoomKeyboard, isPersonalRoom } from './roomLink.js'
import { mentionOr } from '../../lib/mention.js'
import { recordTrackPlayed } from '../stats.js'
import { recordTrackListen, notifyLevelUp } from '../../lib/ranking.js'
import { resolveGroupInfo, writeRoomName } from './roomGroup.js'
import { readRoomSettings, readRoomAutoplay, writeRoomAutoplay } from './roomSettings.js'
import { lines, paragraphs } from '../../lib/md.js'
import { tg, dp, botInfo } from '../../client.js'
import { acquireAudio } from '../media/acquire.js'
import { getDirectVideoUrl } from '../media/ytdlp.js'
import { extractVideoId, type ResolvedTrack } from '../media/musicSource.js'
import { getRecommendedTracks, type TrackSeed } from '../media/recommendations.js'
import { downloadingCard, coverEmbed, type CardInfo } from '../playback/playcard.js'
import { probeMediaDuration } from '../media/parse.js'
import type { RoomMode } from '../../models/roomAccess.js'
import {
  CHAT_LOG_MAX,
  CHAT_MIN_INTERVAL_MS,
  GESTURE_MIN_INTERVAL_MS,
  POSE_TICK_MS,
  ROOM_ANOMALY_COOLDOWN_MS,
  ROOM_LIGHTS_MAX,
  ROOM_NAME_MAX,
} from './roomTypes.js'
import type {
  RoomChatMessage,
  RoomEvent,
  RoomGestureKind,
  RoomParticipant,
  RoomPose,
  RoomSnapshot,
  RoomTrack,
  RoomVideoQuality,
  ServerMessage,
} from './roomTypes.js'

const QUALITY_TIERS: { label: RoomVideoQuality['label']; height: number }[] = [
  { label: 'SD', height: 480 },
  { label: 'HD', height: 720 },
  { label: 'FHD', height: 1080 },
  { label: 'QHD', height: 1440 },
  { label: 'UHD', height: 2160 },
]

function labelForHeight(h: number): RoomVideoQuality['label'] {
  if (h <= 540) return 'SD'
  if (h <= 800) return 'HD'
  if (h <= 1200) return 'FHD'
  if (h <= 1600) return 'QHD'
  return 'UHD'
}

/**
 * Attach a no-op rejection handler to a promise that is created now but may not
 * be awaited until much later - or abandoned entirely.
 *
 * The prefetch path kicks off `getDirectVideoUrl` for a recommended track the
 * moment the current one starts, then only awaits it when that track ends,
 * minutes later. A googlevideo URL for a video that has since gone private
 * rejects in seconds, into a promise nobody is holding yet - which Node treats
 * as an unhandled rejection and, with no process handler, a fatal one. This
 * keeps the promise "handled" from birth; real consumers still `await` the same
 * promise and catch the failure in their own try/catch.
 */
function defuse<T>(p: Promise<T>): Promise<T> {
  p.catch(() => {})
  return p
}

const JOIN_NOTICE_COOLDOWN_MS = 30 * 60_000

const JOIN_EMOJI = emojiTag('👤', '5814550759961793482')

/** Long titles get cut, so a card stays a card. */
const TITLE_MAX = 46

function shortTitle(text: string): string {
  const clean = text.trim()
  return clean.length <= TITLE_MAX
    ? clean
    : `${clean.slice(0, TITLE_MAX - 1).trimEnd()}…`
}

export type GroupNotifier = (
  groupId: string,
  text: ReturnType<typeof md>,
  keyboard?: ReturnType<typeof BotKeyboard.inline>,
) => void

function formatClock(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const mm = h ? String(m).padStart(2, '0') : String(m)
  const ss = String(sec).padStart(2, '0')
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}

type InternalTrack = RoomTrack & {
  /**
   * Where to pick this track up from, in seconds.
   *
   * Set when a track is interrupted by a forced play and put back in the queue,
   * so that when its turn comes round again it starts where it was taken off
   * rather than from the top. Cleared the moment it is applied - a track that
   * runs to its end and is queued again later is a fresh play.
   */
  resumeAtSec?: number
  mediaFsPath?: string
  acquireMedia?: () => Promise<{ path: string; dispose: () => Promise<void> }>
  statusMessageId?: number
  replaySource?: unknown
  cardVideoHeight?: number | null
  dispose: () => Promise<void>
  mediaId?: string
  videoDirectUrl?: string
  videoSourceUrl?: string
  videoMaxHeight?: number
  videoQualities?: RoomVideoQuality[]
}

type Connection = {
  id: string
  ws: WebSocket
  participant: RoomParticipant
  videoUrl?: string
  videoUrlTrackId?: string
  /**
   * Where this connection is in the 3D lounge, if it is in it at all.
   *
   * Held on the connection rather than the participant so it dies with the
   * socket: a body left standing in the room after someone's phone dropped the
   * connection is worse than no body, and needs no timeout to clean up.
   */
  pose?: RoomPose
  /**
   * When this connection last said something, and last threw a gesture.
   *
   * Per connection rather than per user, which is the looser of the two and the
   * right one: a second tab is a second socket, and this exists to stop one
   * client flooding a room rather than to ration what a person may say.
   */
  lastSayAt?: number
  lastGestureAt?: number
}

type ListenerTracking = {
  userId: number
  profile: { username?: string; firstName?: string; lastName?: string }
  activeSince: number | null
  accumulatedMs: number
  credited?: boolean
}

type TrackSession = {
  trackId: string
  title: string
  durationSec: number
  requesterId?: string
  requesterName?: string
  requesterCredited?: boolean
  listeners: Map<string, ListenerTracking>
}

type Room = {
  groupId: string
  title: string | null
  roomName: string | null
  avatarUrl: string | null
  avatarPath: string | null
  rev: number
  connections: Map<string, Connection>
  queue: InternalTrack[]
  current: InternalTrack | null
  playing: boolean
  startedAt: number
  pausedPositionSec: number
  loopRemaining: number
  endTimer: ReturnType<typeof setTimeout> | null
  trackSession?: TrackSession | null
  /** How many bodies the last pose tick told this room about. */
  posesSent?: number
  /** Which ceiling lamps are lit in the 3D lounge. Absent means all of them. */
  lights?: boolean[]
  /**
   * The last few things said in the room, oldest first.
   *
   * Kept only so that somebody who joins mid-conversation is not dropped into a
   * silent room. Trimmed to `CHAT_LOG_MAX` on every push, and gone with the
   * process - like the lamps, the poses and everything else in here.
   */
  chat?: RoomChatMessage[]
  /** When the lounge's lights were last called down, for the cooldown. */
  anomalyAt?: number
  autoplay?: boolean
  recentTrackIds?: string[]
  recentTrackHistory?: TrackSeed[]
  prefetchedRecommendations?: ResolvedTrack[]
  prefetchedMedia?: {
    track: ResolvedTrack
    audioPromise: Promise<{ path: string; dispose: () => Promise<void> }>
    videoDirectPromise?: Promise<{ url: string; height: number | null }>
    video?: boolean
    canceled?: boolean
  }
  autoplayAcquiring?: boolean
  trackHadPresence?: boolean
  autoPaused?: boolean
}

export type RoomEnqueueInput = {
  groupId: string
  title: string
  artist?: string | null
  artistAvatar?: string | null
  /** The performer, when `artist` is showing the source instead. */
  lyricsArtist?: string | null
  duration: number | null
  sourceUrl?: string | null
  thumbnail: string | null
  video: boolean
  requestedBy: string
  requestedById?: string
  mediaFsPath?: string
  acquireMedia?: () => Promise<{ path: string; dispose: () => Promise<void> }>
  dispose?: () => Promise<void>
  sourceMode?: 'download' | 'split'
  videoDirectUrl?: string
  videoSourceUrl?: string
  videoMaxHeight?: number
  cardVideoHeight?: number | null
  statusMessageId?: number
  replaySource?: unknown
  /**
   * Start this one now and push whatever is playing back to the front of the
   * queue, keeping its position. See {@link RoomManagerImpl.forcePlay}.
   */
  force?: boolean
}

export type RoomPublicSnapshot = Omit<RoomSnapshot, 'type'>

export type RoomCardTrack = {
  statusMessageId?: number
  title: string
  duration: number | null
  sourceUrl?: string | null
  requestedBy: string
  requestedById?: string
  video: boolean
  thumbnail: string | null
  videoHeight?: number | null
  replaySource?: unknown
}

export type RoomLifecycle = {
  onAdvance: (
    groupId: string,
    ev: {
      finished: RoomCardTrack | null
      next: RoomCardTrack | null
      /**
       * `postponed` is a forced play: the finished track did not finish. It is
       * back at the head of the queue with its position kept, and its card in
       * the chat has to say so rather than claim it played out.
       */
      reason: 'natural' | 'skip' | 'postponed'
      /** Who forced it, for the line printed on the postponed card. */
      by?: { name: string; id?: string }
      /** Where the postponed track will pick up, in seconds. */
      resumeAtSec?: number
    },
  ) => void
  /**
   * Play, pause or seek - whoever asked for it.
   *
   * The card's Pause/Resume button used to be repainted by whichever handler
   * happened to trigger the change, which meant it tracked the room only when
   * the change came from Telegram. Paused from the web and the button went on
   * saying Pause. Announced from here instead, so it is the room state that
   * drives the button rather than the route the request arrived by.
   */
  onTransport?: (groupId: string) => void
}

class RoomManagerImpl {
  private readonly rooms = new Map<string, Room>()

  private readonly userRoom = new Map<string, string>()

  /** One timer for every room's lounge, alive only while someone is in one. */
  private poseTimer?: ReturnType<typeof setInterval>

  currentRoomOf(userId: string): string | null {
    return this.userRoom.get(userId) ?? null
  }

  private evictUser(groupId: string, userId: string): void {
    const room = this.rooms.get(groupId)
    if (!room) return
    const gone = [...room.connections.values()].filter((c) => c.participant.id === userId)
    if (gone.length === 0) return
    for (const c of gone) {
      try {
        c.ws.send(JSON.stringify({ type: 'closed', reason: 'joined_elsewhere' } satisfies ServerMessage))
      } catch {
      }
      room.connections.delete(c.id)
      this.onConnectionLeave(room, userId)
      try {
        c.ws.close(4000, 'joined_elsewhere')
      } catch {
      }
    }
    this.emit(room, { kind: 'leave', actor: gone[0]!.participant.name, actorId: userId })
    if (room.connections.size === 0 && room.playing && room.current) {
      room.autoPaused = true
      this.pause(groupId, 'Room', 'auto_empty')
      const icon = md(emojiTag('⏸️', TEXT_PAUSE_EMOJI_ID))
      this.notifyGroup(groupId, md`${icon} Playback paused because the room is empty.`)
    }
    this.broadcast(room)
  }

  private notifier?: GroupNotifier

  setGroupNotifier(fn: GroupNotifier): void {
    this.notifier = fn
  }

  setAutoplay(groupId: string, enabled: boolean): void {
    const room = this.getOrCreate(groupId)
    room.autoplay = enabled
    void writeRoomAutoplay(groupId, enabled).catch(() => {})
  }

  getAutoplay(groupId: string): boolean {
    return this.getOrCreate(groupId).autoplay === true
  }

  getPrefetchedRecommendations(groupId: string): ResolvedTrack[] | null {
    const room = this.rooms.get(groupId)
    return room?.prefetchedRecommendations ?? null
  }

  getRecentTrackHistory(groupId: string): TrackSeed[] {
    const room = this.rooms.get(groupId)
    return room?.recentTrackHistory ?? []
  }

  private lastJoinNotice = new Map<string, number>()

  private allowJoinNotice(groupId: string, userId: string): boolean {
    const key = `${groupId}:${userId}`
    const now = Date.now()
    const last = this.lastJoinNotice.get(key)
    if (last != null && now - last < JOIN_NOTICE_COOLDOWN_MS) return false
    this.lastJoinNotice.set(key, now)
    if (this.lastJoinNotice.size > 5000) {
      for (const [k, t] of this.lastJoinNotice) {
        if (now - t >= JOIN_NOTICE_COOLDOWN_MS) this.lastJoinNotice.delete(k)
      }
    }
    return true
  }

  private lifecycle?: RoomLifecycle

  setLifecycle(fn: RoomLifecycle): void {
    this.lifecycle = fn
  }

  private cardTrack(t: InternalTrack): RoomCardTrack {
    return {
      statusMessageId: t.statusMessageId,
      title: t.title,
      duration: t.duration,
      sourceUrl: t.sourceUrl,
      requestedBy: t.requestedBy,
      requestedById: t.requestedById,
      video: t.video,
      thumbnail: t.thumbnail,
      videoHeight: t.cardVideoHeight,
      replaySource: t.replaySource,
    }
  }

  private mentionOrYou(groupId: string, name: string, actorId?: string): ReturnType<typeof md> {
    return isPersonalRoom(groupId) && actorId === groupId ? md`**you**` : mentionOr(name, actorId)
  }

  private notifyGroup(groupId: string, text: ReturnType<typeof md>, keyboard?: ReturnType<typeof BotKeyboard.inline>): void {
    this.notifier?.(groupId, text, keyboard)
  }

  /** Is this user connected to this room right now, on any device? */
  isPresent(roomId: string, userId: string): boolean {
    const room = this.rooms.get(roomId)
    if (!room) return false
    for (const conn of room.connections.values()) {
      if (conn.participant.online && conn.participant.id === userId) return true
    }
    return false
  }

  /** One entry per person, in join order, however many devices they are on. */
  private presentPeople(room: Room): { id: string; name: string }[] {
    const seen = new Map<string, string>()
    for (const conn of room.connections.values()) {
      const p = conn.participant
      if (!p.online) continue
      if (!seen.has(p.id)) seen.set(p.id, p.name)
    }
    return [...seen].map(([id, name]) => ({ id, name }))
  }

  /**
   * What the group is told when somebody walks in.
   *
   * Three things, and each earns its line. Who arrived, because that is the
   * event. Who else is already there, because the notice is really an
   * invitation and "four people are in there" is the part that makes anyone
   * else tap the button - the old one-liner told the group somebody joined and
   * left them to guess whether the room was worth opening. And what is playing,
   * because that is the other half of the same question.
   *
   * Which room they landed in gets named too, now that a room can be either:
   * the lounge and the player are different enough places that "joined the
   * room" is no longer a full description of what just happened.
   */
  /**
   * What the chat is told when somebody walks in.
   *
   * Laid out like the `/room` card on purpose, because it is answering the same
   * question a moment earlier: what is on, and who is in there. Somebody
   * reading this is deciding whether to tap Join, and "three people are in
   * there watching something" is the whole of what decides it.
   *
   * Built from parts rather than from a `Room` so that `/demo` can render one
   * for a room that does not exist yet.
   */
  private joinNotice(input: {
    joiner: { id: string; name: string }
    current: { title: string; video: boolean; sourceUrl?: string | null } | null
    personal: boolean
    mode: RoomMode
  }): ReturnType<typeof md> {
    const place = input.personal
      ? 'your room'
      : input.mode === '2d'
        ? 'the player'
        : 'the lounge'

    const head = md`${md(JOIN_EMOJI)} **${mentionOr(
      input.joiner.name,
      input.joiner.id,
    )} joined ${place}**`

    /*
      What is on, or nothing at all.

      No "nothing is playing" line: this message is unsolicited, and a line
      whose whole content is the absence of news is the part that makes an
      unsolicited message feel like noise. If there is something on it is worth
      a line, and if there is not, the message is one line long.
    */
    const track = input.current
    const title = shortTitle(track?.title ?? '')
    const playing = track
      ? md`**${track.video ? 'Streaming' : 'Now Playing'}:** ${
          track.sourceUrl ? md`[${title}](${track.sourceUrl})` : md`${title}`
        }`
      : md``

    /*
      And no roll call.

      The room card lists everybody, because somebody asked it to. This arrives
      on its own, several times an evening, in a chat people are using for other
      things - and a bulleted list of names showing up unasked is what spam
      looks like, however true it is.
    */
    return paragraphs(head, playing)
  }

  /**
   * The same notice, for a room that may have nobody in it.
   *
   * Exists for `/demo`: the point of that command is to see what the chat sees
   * without waiting for somebody to actually open the app, and rendering it any
   * other way would be a second copy of this to keep in step.
   */
  async previewJoinNotice(
    groupId: string,
    joiner: { id: string; name: string },
  ): Promise<ReturnType<typeof md>> {
    const room = this.rooms.get(groupId)
    const settings = await readRoomSettings(groupId)

    return this.joinNotice({
      joiner,
      current: room?.current ?? null,
      personal: isPersonalRoom(groupId),
      mode: settings.mode,
    })
  }

  private videoUrlGen?: (sourceUrl: string, maxHeight: number) => Promise<string>

  setVideoUrlGenerator(fn: (sourceUrl: string, maxHeight: number) => Promise<string>): void {
    this.videoUrlGen = fn
  }

  private videoQualityGen?: (sourceUrl: string, maxHeight: number) => Promise<{ url: string; height: number | null }>

  setVideoQualityGenerator(
    fn: (sourceUrl: string, maxHeight: number) => Promise<{ url: string; height: number | null }>,
  ): void {
    this.videoQualityGen = fn
  }

  private selectTiers(maxHeight: number): { label: RoomVideoQuality['label']; height: number }[] {
    let tiers = QUALITY_TIERS.filter((t) => t.height <= maxHeight)
    if (tiers.length === 0) tiers = [QUALITY_TIERS[0]!]
    return tiers
  }

  private async mintQualityLadder(groupId: string, trackId: string): Promise<void> {
    if (!config.room.videoQualityLadder || !this.videoQualityGen) return
    const room = this.rooms.get(groupId)
    const track = room?.current
    if (!room || !track || track.id !== trackId || track.sourceMode !== 'split' || !track.videoSourceUrl) return
    const source = track.videoSourceUrl
    const gen = this.videoQualityGen
    const tiers = this.selectTiers(track.videoMaxHeight ?? 1080)

    const results: ({ url: string; height: number } | null)[] = []
    let next = 0
    const worker = async (): Promise<void> => {
      while (next < tiers.length) {
        const t = tiers[next++]!
        if (this.rooms.get(groupId)?.current?.id !== trackId) return
        try {
          const { url, height } = await gen(source, t.height)
          results.push({ url, height: height ?? t.height })
        } catch {
          results.push(null)
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(2, tiers.length) }, () => worker()))

    const byHeight = new Map<number, RoomVideoQuality>()
    if (track.videoDirectUrl && track.cardVideoHeight) {
      byHeight.set(track.cardVideoHeight, {
        label: labelForHeight(track.cardVideoHeight),
        height: track.cardVideoHeight,
        url: track.videoDirectUrl,
      })
    }
    for (const r of results) {
      if (r && !byHeight.has(r.height)) {
        byHeight.set(r.height, { label: labelForHeight(r.height), height: r.height, url: r.url })
      }
    }
    const ladder = [...byHeight.values()].sort((a, b) => b.height - a.height).slice(0, 5)
    if (ladder.length === 0) return

    const fresh = this.rooms.get(groupId)
    if (!fresh || fresh.current?.id !== trackId) return
    fresh.current.videoQualities = ladder
    this.broadcast(fresh)
  }

  async refreshParticipantVideo(groupId: string, connId: string): Promise<void> {
    if (!config.room.perParticipantVideoUrl || !this.videoUrlGen) return
    const room = this.rooms.get(groupId)
    const conn = room?.connections.get(connId)
    const track = room?.current
    if (!room || !conn || !track || track.sourceMode !== 'split' || !track.videoSourceUrl) return
    const trackId = track.id
    try {
      const url = await this.videoUrlGen(track.videoSourceUrl, track.videoMaxHeight ?? 1080)
      const freshRoom = this.rooms.get(groupId)
      const freshConn = freshRoom?.connections.get(connId)
      if (!freshRoom || !freshConn || freshRoom.current?.id !== trackId) return
      freshConn.videoUrl = url
      freshConn.videoUrlTrackId = trackId
      this.sendSnapshotToConn(freshRoom, freshConn)
    } catch {
    }
  }

  private refreshAllParticipantVideos(groupId: string): void {
    const room = this.rooms.get(groupId)
    if (!room) return
    for (const conn of room.connections.values()) {
      void this.refreshParticipantVideo(groupId, conn.id)
    }
  }

  private getOrCreate(groupId: string): Room {
    let room = this.rooms.get(groupId)
    if (!room) {
      room = {
        groupId,
        title: null,
        roomName: null,
        avatarUrl: null,
        avatarPath: null,
        rev: 0,
        connections: new Map(),
        queue: [],
        current: null,
        playing: false,
        startedAt: 0,
        pausedPositionSec: 0,
        loopRemaining: 0,
        endTimer: null,
        autoplay: false,
        recentTrackIds: [],
      }
      this.rooms.set(groupId, room)
      void readRoomAutoplay(groupId).then((ap) => {
        if (room) room.autoplay = ap
      }).catch(() => {})
    }
    return room
  }

  private positionSec(room: Room): number {
    if (!room.current) return 0
    if (!room.playing) return room.pausedPositionSec
    return Math.max(0, (Date.now() - room.startedAt) / 1000)
  }

  mediaPath(groupId: string, mediaId: string): string | null {
    const room = this.rooms.get(groupId)
    if (room?.current?.mediaId === mediaId) return room.current.mediaFsPath ?? null
    return null
  }

  avatarPath(groupId: string): string | null {
    return this.rooms.get(groupId)?.avatarPath ?? null
  }

  hasGroupInfo(groupId: string): boolean {
    return this.rooms.get(groupId)?.title != null
  }

  hasRoom(groupId: string): boolean {
    return this.rooms.has(groupId)
  }

  setGroupInfo(
    groupId: string,
    info: { title: string | null; avatarPath: string | null; roomName: string | null },
  ): void {
    const room = this.getOrCreate(groupId)
    room.title = info.title
    room.roomName = info.roomName
    room.avatarPath = info.avatarPath
    room.avatarUrl = info.avatarPath
      ? `${config.room.publicUrl}/avatar/${encodeURIComponent(groupId)}`
      : null
    this.broadcast(room)
  }

  async setRoomName(groupId: string, rawName: string): Promise<void> {
    if (!isPersonalRoom(groupId)) return
    const name = rawName.replace(/\s+/g, ' ').trim().slice(0, ROOM_NAME_MAX) || null
    await writeRoomName(groupId, name)
    const info = await resolveGroupInfo(groupId)
    this.setGroupInfo(groupId, info)
  }

  addConnection(
    groupId: string,
    ws: WebSocket,
    participant: RoomParticipant,
    preset?: { videoUrl: string; videoUrlTrackId: string },
  ): string {
    for (const [otherId, other] of this.rooms) {
      if (otherId === groupId) continue
      if ([...other.connections.values()].some((c) => c.participant.id === participant.id)) {
        this.evictUser(otherId, participant.id)
      }
    }
    this.userRoom.set(participant.id, groupId)

    const room = this.getOrCreate(groupId)
    const isNewUser = ![...room.connections.values()].some((c) => c.participant.id === participant.id)
    const id = randomUUID()
    const usePreset = preset && room.current?.id === preset.videoUrlTrackId
    room.connections.set(id, {
      id,
      ws,
      participant,
      videoUrl: usePreset ? preset.videoUrl : undefined,
      videoUrlTrackId: usePreset ? preset.videoUrlTrackId : undefined,
    })
    room.trackHadPresence = true
    this.onConnectionJoin(room, participant)
    if (room.autoPaused && !room.playing && room.current) {
      room.autoPaused = false
      this.play(groupId, 'Room', 'auto_join')
      const icon = md(emojiTag('▶️', TEXT_PLAY_EMOJI_ID))
      this.notifyGroup(groupId, md`${icon} Playback resumed.`)
    }
    if (isNewUser) {
      this.emit(room, { kind: 'join', actor: participant.name, actorId: participant.id })
      const personal = isPersonalRoom(groupId)
      const isSelf = personal && participant.id === groupId
      if (!isSelf && this.allowJoinNotice(groupId, participant.id)) {
        /*
          The room's mode is read before the notice goes out, not carried on
          the room.

          It is a database field an admin can change between two people
          arriving, and the notice is already fire-and-forget - so a read here
          costs the message nothing anybody is waiting on, and saves the room
          from holding a copy of a setting it has no other use for.
        */
        void readRoomSettings(groupId).then((settings) => {
          this.notifyGroup(
            groupId,
            this.joinNotice({
              joiner: participant,
              current: room.current,
              personal,
              mode: settings.mode,
            }),
            /*
              No Join button for somebody who is already inside.

              A personal room's notice goes to one person, and if that person
              has the app open they are looking at the room while being invited
              into it. The button is the only reason the message has a keyboard,
              so it goes rather than sitting there greyed out in spirit.
            */
            personal && this.isPresent(groupId, groupId)
              ? undefined
              : joinRoomKeyboard(groupId),
          )
        })
      }
    }
    this.broadcast(room)
    return id
  }

  currentSplitSource(groupId: string): { trackId: string; sourceUrl: string; maxHeight: number } | null {
    if (!config.room.perParticipantVideoUrl) return null
    const track = this.rooms.get(groupId)?.current
    if (!track || track.sourceMode !== 'split' || !track.videoSourceUrl) return null
    return { trackId: track.id, sourceUrl: track.videoSourceUrl, maxHeight: track.videoMaxHeight ?? 1080 }
  }

  /**
   * Which CDN URL a proxy request should be served from.
   *
   * Resolved entirely from room state: the client names a room, a track and a
   * rung, and gets back whatever *this room* minted for it. Nothing the caller
   * sends is ever used as a URL, which is the difference between a proxy for
   * this room's video and an open proxy for the internet.
   */
  videoUpstream(
    groupId: string,
    trackId: string,
    userId: string,
    height?: number,
  ): string | null {
    const room = this.rooms.get(groupId)
    const track = room?.current
    if (!room || !track || track.id !== trackId || track.sourceMode !== 'split') return null

    // The rung the client asked for, when the ladder has it.
    if (height) {
      const rung = track.videoQualities?.find((q) => q.height === height)
      if (rung) return rung.url
    }

    // Per-participant minting hands every viewer their own URL, and theirs is
    // the one their session has been playing.
    if (config.room.perParticipantVideoUrl) {
      for (const conn of room.connections.values()) {
        if (
          conn.participant.id === userId &&
          conn.videoUrlTrackId === trackId &&
          conn.videoUrl
        ) {
          return conn.videoUrl
        }
      }
    }

    return track.videoDirectUrl ?? null
  }

  /**
   * Mint a replacement for a URL the CDN has stopped honouring, and keep it.
   *
   * A mint is good for hours, not days, and a room can sit paused for longer
   * than that - so the first sign of expiry is usually a 403 mid-session rather
   * than at the start. Re-minting here means the client sees a stall rather
   * than a dead screen, and the next request reuses the fresh URL.
   */
  async remintVideo(
    groupId: string,
    trackId: string,
    height?: number,
  ): Promise<string | null> {
    const track = this.rooms.get(groupId)?.current
    if (!track || track.id !== trackId || track.sourceMode !== 'split') return null
    if (!track.videoSourceUrl || !this.videoUrlGen) return null

    try {
      const url = await this.videoUrlGen(
        track.videoSourceUrl,
        height ?? track.videoMaxHeight ?? 1080,
      )
      // The track may have changed while yt-dlp was working; the URL is still
      // good for the request in flight, it just is not worth remembering.
      const fresh = this.rooms.get(groupId)?.current
      if (fresh && fresh.id === trackId) {
        const rung = height
          ? fresh.videoQualities?.find((q) => q.height === height)
          : undefined
        if (rung) rung.url = url
        else fresh.videoDirectUrl = url
      }
      return url
    } catch {
      return null
    }
  }

  sendSnapshotToConnection(groupId: string, connId: string): void {
    const room = this.rooms.get(groupId)
    const conn = room?.connections.get(connId)
    if (room && conn) this.sendSnapshotToConn(room, conn)
  }

  removeConnection(groupId: string, connId: string): void {
    const room = this.rooms.get(groupId)
    if (!room) return
    const gone = room.connections.get(connId)
    if (!room.connections.delete(connId)) return
    if (gone) this.onConnectionLeave(room, gone.participant.id)
    if (gone && ![...room.connections.values()].some((c) => c.participant.id === gone.participant.id)) {
      this.emit(room, { kind: 'leave', actor: gone.participant.name, actorId: gone.participant.id })
      if (this.userRoom.get(gone.participant.id) === groupId) this.userRoom.delete(gone.participant.id)
    }
    if (room.connections.size === 0 && room.playing && room.current) {
      room.autoPaused = true
      this.pause(groupId, 'Room', 'auto_empty')
      const icon = md(emojiTag('⏸️', TEXT_PAUSE_EMOJI_ID))
      this.notifyGroup(groupId, md`${icon} Playback paused because the room is empty.`)
    }
    this.broadcast(room)
  }

  setPresence(groupId: string, connId: string, present: boolean): void {
    const room = this.rooms.get(groupId)
    const conn = room?.connections.get(connId)
    if (!room || !conn || conn.participant.present === present) return
    conn.participant.present = present
    this.broadcast(room)
  }

  // ── the 3D lounge ────────────────────────────────────────────────────────────

  /**
   * Take one client's position in the lounge, or drop it when they leave.
   *
   * Nothing is broadcast here. Poses arrive ten times a second from every
   * client in the room, and answering each one immediately would turn n
   * senders into n² messages; the tick below sends one message per client per
   * period regardless of how many are moving.
   */
  /**
   * Work one of a lounge's light switches, for everyone in it.
   *
   * Stored as given and never validated against the room, exactly as poses are:
   * the server has no model of that lounge and does not know how many lamps it
   * has. All it enforces is the ceiling on the index, because an unbounded one
   * is an allocation a client should not be able to ask for.
   *
   * Grows the array with `true`, so a room that has only ever had its third lamp
   * touched still describes the other two as lit rather than as unknown.
   */
  setLight(groupId: string, index: number, on: boolean): void {
    if (!Number.isInteger(index) || index < 0 || index >= ROOM_LIGHTS_MAX) return
    const room = this.rooms.get(groupId)
    if (!room) return

    const lights = room.lights ?? []
    while (lights.length <= index) lights.push(true)
    if (lights[index] === on) return
    lights[index] = on
    room.lights = lights

    // The lamps alone, not a snapshot: nothing about the queue, the roster or
    // the transport has changed, and a revision bump would re-render all three
    // on every client for a light switch.
    this.send(room, { type: 'lights', lights: [...lights] })
  }

  /**
   * Call the lounge's lights down for everyone in the room.
   *
   * The server keeps no state about the failure beyond when it started, because
   * it has none to keep: the anomaly is a lounge behaviour, and this is the cue
   * that starts it in every copy of the lounge at once. A client that joins
   * midway through is told nothing and misses it, which is correct - it is an
   * event, not a condition of the room.
   */
  callAnomaly(groupId: string): void {
    const room = this.rooms.get(groupId)
    if (!room) return
    const now = Date.now()
    if (room.anomalyAt && now - room.anomalyAt < ROOM_ANOMALY_COOLDOWN_MS) return
    room.anomalyAt = now
    this.send(room, { type: 'anomaly', at: now })
  }

  setPose(groupId: string, connId: string, pose: RoomPose | null): void {
    const conn = this.rooms.get(groupId)?.connections.get(connId)
    if (!conn) return
    if (!pose) {
      delete conn.pose
      return
    }
    conn.pose = pose
    this.startPoseLoop()
  }

  /**
   * Fan every lounge's poses out, on one timer for the whole server.
   *
   * Started by the first pose that arrives and stopped by the first tick that
   * finds none, so a bot whose users never open the 3D room pays nothing for
   * it. `unref` so it can never be the thing keeping the process alive.
   */
  private startPoseLoop(): void {
    if (this.poseTimer) return
    this.poseTimer = setInterval(() => this.tickPoses(), POSE_TICK_MS)
    this.poseTimer.unref?.()
  }

  private tickPoses(): void {
    let anyPoses = false

    for (const room of this.rooms.values()) {
      if (room.playing && room.trackSession) {
        this.checkAndCreditListeners(room)
      }
      /*
        One pose per *user*, last writer wins.

        A user can hold more than one connection to a room - a second tab, or a
        reconnect whose old socket has not been reaped yet - and each would
        otherwise contribute a body, so the room would show a crowd of one
        person standing inside themselves.
      */
      const byUser = new Map<string, RoomPose & { id: string }>()
      for (const conn of room.connections.values()) {
        if (conn.pose) byUser.set(conn.participant.id, { id: conn.participant.id, ...conn.pose })
      }
      const before = room.posesSent ?? 0
      room.posesSent = byUser.size
      if (byUser.size === 0) continue
      anyPoses = true

      /*
        Nobody to tell but the one person in there - their own body is drawn
        from their own controller, never from what comes back.

        The exception is the tick where a second person *stopped* being there.
        Whoever is left has to hear one more message to learn that, because the
        list is the whole truth: a body nobody mentions is a body that has gone,
        and without this send it would stand in the room until the last person
        left too.
      */
      if (byUser.size < 2 && before < 2) continue

      this.fanOutPoses(room, byUser)
    }

    if (!anyPoses) this.stopPoseLoop()
  }

  private posesOf(room: Room): Map<string, RoomPose & { id: string }> {
    const byUser = new Map<string, RoomPose & { id: string }>()
    for (const conn of room.connections.values()) {
      if (conn.pose) byUser.set(conn.participant.id, { id: conn.participant.id, ...conn.pose })
    }
    return byUser
  }

  private fanOutPoses(room: Room, byUser: Map<string, RoomPose & { id: string }>): void {
    if (byUser.size === 0) return

    const payload = JSON.stringify({
      type: 'poses',
      poses: [...byUser.values()],
      at: Date.now(),
    } satisfies ServerMessage)

    for (const conn of room.connections.values()) {
      // Only the clients that are in the lounge care. Someone on the 2D
      // player is on the same socket and has no use for any of this.
      if (!conn.pose || conn.ws.readyState !== conn.ws.OPEN) continue
      try {
        conn.ws.send(payload)
      } catch {
      }
    }
  }

  private stopPoseLoop(): void {
    if (this.poseTimer) clearInterval(this.poseTimer)
    this.poseTimer = undefined
  }

  /**
   * Throw a gesture at somebody else in the room.
   *
   * Sent only to the connections that are in the lounge, exactly as poses are:
   * this ends in two bodies animating, and a client on the 2D player has no
   * bodies to animate. The target being reachable at all is already settled by
   * then - an invisible body cannot be aimed at - so all that is checked here is
   * that they are in this room and are not the sender.
   */
  gesture(groupId: string, connId: string, kind: RoomGestureKind, targetId: string): void {
    const room = this.rooms.get(groupId)
    const conn = room?.connections.get(connId)
    if (!room || !conn) return

    const from = conn.participant.id
    if (!targetId || targetId === from) return

    const now = Date.now()
    if (conn.lastGestureAt && now - conn.lastGestureAt < GESTURE_MIN_INTERVAL_MS) return

    const here = [...room.connections.values()].some((c) => c.participant.id === targetId)
    if (!here) return
    conn.lastGestureAt = now

    /*
      Poses normally fan out on a 100ms timer while a gesture relays the instant
      it arrives, so the animation would otherwise reach everyone before the
      pose that says where the actor was standing when they threw it. Every
      client would start the swing from a stale position and slide into place
      over the next tick, which reads as the body drifting towards its target
      rather than reaching it. Flushing first costs one extra message per
      gesture and makes the two arrive together.
    */
    this.fanOutPoses(room, this.posesOf(room))

    const payload = JSON.stringify({ type: 'gesture', kind, from, to: targetId, at: now } satisfies ServerMessage)
    for (const c of room.connections.values()) {
      if (!c.pose || c.ws.readyState !== c.ws.OPEN) continue
      try {
        c.ws.send(payload)
      } catch {
      }
    }
  }

  // ── talking ──────────────────────────────────────────────────────────────────

  /**
   * Say something to the room, typed or picked out of the reaction tray.
   *
   * The text arrives already trimmed and bounded - that is wire hygiene and
   * belongs at the socket - so what is left here is the room's part: mint it,
   * remember it, and tell everybody at once, the sender included. Their own
   * client draws nothing until this comes back, which is what keeps a refused
   * line from being one that only its author believes was said.
   *
   * Sent to the whole room rather than to the lounge alone, unlike a gesture: a
   * line of chat is not a thing bodies do, and somebody on the 2D player is
   * still in the conversation.
   */
  say(groupId: string, connId: string, kind: RoomChatMessage['kind'], text: string): void {
    const room = this.rooms.get(groupId)
    const conn = room?.connections.get(connId)
    if (!room || !conn || !text) return

    const now = Date.now()
    if (conn.lastSayAt && now - conn.lastSayAt < CHAT_MIN_INTERVAL_MS) return
    conn.lastSayAt = now

    const message: RoomChatMessage = {
      id: randomUUID(),
      from: conn.participant.id,
      name: conn.participant.name,
      kind,
      text,
      at: now,
    }

    const log = (room.chat ??= [])
    log.push(message)
    // Trimmed from the front, so the log is the *last* few things said.
    if (log.length > CHAT_LOG_MAX) log.splice(0, log.length - CHAT_LOG_MAX)

    this.send(room, { type: 'chat', message })
  }

  /**
   * Hand a freshly opened connection the conversation so far.
   *
   * Once, on the way in, and skipped entirely when there is nothing to say -
   * an empty log is a message every connection would otherwise pay for so that
   * the client could learn nothing from it.
   */
  sendChatLogToConnection(groupId: string, connId: string): void {
    const room = this.rooms.get(groupId)
    const conn = room?.connections.get(connId)
    if (!room || !conn || conn.ws.readyState !== conn.ws.OPEN) return
    const messages = room.chat
    if (!messages || messages.length === 0) return
    try {
      conn.ws.send(JSON.stringify({ type: 'chatlog', messages } satisfies ServerMessage))
    } catch {
    }
  }

  snapshotFor(groupId: string): RoomSnapshot {
    return this.buildSnapshot(this.getOrCreate(groupId))
  }

  /**
   * What the mini-app's join screen shows before anyone connects.
   *
   * Deliberately not `snapshotFor`: that goes through `getOrCreate` and would
   * spawn an empty room for every link preview, and a full snapshot carries
   * media URLs that someone who hasn't joined has no business holding. Returns
   * null for a room that isn't live so the caller can render an empty state.
   */
  preview(groupId: string): {
    groupId: string
    title: string | null
    roomName: string | null
    avatarUrl: string | null
    playing: boolean
    current: { title: string; video: boolean; thumbnail: string | null } | null
    queued: number
    participants: { id: string; name: string; photoUrl?: string }[]
  } | null {
    const room = this.rooms.get(groupId)
    if (!room) return null

    // one entry per user, not per socket - the same person on two devices is
    // still one face on the join screen
    const byUser = new Map<string, { id: string; name: string; photoUrl?: string }>()
    for (const conn of room.connections.values()) {
      const p = conn.participant
      if (!p.online) continue
      if (!byUser.has(p.id)) byUser.set(p.id, { id: p.id, name: p.name, photoUrl: p.photoUrl })
    }

    return {
      groupId: room.groupId,
      title: room.title,
      roomName: room.roomName,
      avatarUrl: room.avatarUrl,
      playing: room.playing,
      current: room.current
        ? { title: room.current.title, video: room.current.video, thumbnail: room.current.thumbnail }
        : null,
      queued: room.queue.length,
      participants: [...byUser.values()],
    }
  }

  activeRooms(): { groupId: string; title: string; participants: number; nowPlaying: string | null }[] {
    const out: { groupId: string; title: string; participants: number; nowPlaying: string | null }[] = []
    for (const room of this.rooms.values()) {
      if (!room.current || room.connections.size === 0) continue
      const users = new Set([...room.connections.values()].map((c) => c.participant.id))
      out.push({
        groupId: room.groupId,
        title: room.title ?? room.roomName ?? 'Room',
        participants: users.size,
        nowPlaying: room.current.title,
      })
    }
    return out
  }

  activeRoomCount(): number {
    return this.activeRooms().length
  }

  enqueue(input: RoomEnqueueInput): { position: number; trackId: string } {
    const room = this.getOrCreate(input.groupId)
    const track: InternalTrack = {
      id: randomUUID(),
      title: input.title,
      sourceUrl: input.sourceUrl ?? null,
      artist: input.artist ?? null,
      artistAvatar: input.artistAvatar ?? null,
      lyricsArtist: input.lyricsArtist ?? null,
      duration: input.duration,
      thumbnail: input.thumbnail,
      video: input.video,
      requestedBy: input.requestedBy,
      requestedById: input.requestedById,
      mediaFsPath: input.mediaFsPath,
      acquireMedia: input.acquireMedia,
      dispose: input.dispose ?? (() => Promise.resolve()),
      sourceMode: input.sourceMode,
      videoDirectUrl: input.videoDirectUrl,
      videoSourceUrl: input.videoSourceUrl,
      videoMaxHeight: input.videoMaxHeight,
      statusMessageId: input.statusMessageId,
      replaySource: input.replaySource,
      cardVideoHeight: input.cardVideoHeight ?? null,
    }

    this.emit(room, { kind: 'add', actor: input.requestedBy, actorId: input.requestedById, detail: input.title })

    if (!room.current) {
      this.startTrack(room, track)
      this.broadcast(room)
      return { position: 0, trackId: track.id }
    }

    /*
      Forced: this one starts now and the interrupted track goes to the head of
      the queue with its position kept, exactly as `forcePlay` does it. Queued
      first so there is only one implementation of the interruption, and it is
      the one the button uses too.
    */
    if (input.force) {
      room.queue.unshift(track)
      this.forcePlay(input.groupId, track.id, input.requestedBy, input.requestedById)
      return { position: 0, trackId: track.id }
    }

    if (room.queue.length >= config.room.maxQueue) {
      throw new Error('queue_full')
    }
    room.queue.push(track)
    if (room.queue.length === 1) {
      this.prefetchNext(room)
    }
    this.broadcast(room)
    return { position: room.queue.length, trackId: track.id }
  }

  /**
   * Play a queued track now, and put the current one back in front of the rest.
   *
   * Not a skip. A skip throws the playing track away - this one takes its exact
   * position first and puts it at the head of the queue, so when the forced
   * track finishes the room carries on from the same second it was interrupted
   * at. The interrupted track is deliberately *not* disposed, which is the one
   * thing `advance` does that must not happen here: its media file is about to
   * be needed again.
   */
  forcePlay(
    groupId: string,
    trackId: string,
    actor?: string,
    actorId?: string,
  ): 'ok' | 'nothing' | 'gone' {
    const room = this.rooms.get(groupId)
    if (!room) return 'nothing'

    const at = room.queue.findIndex((t) => t.id === trackId)
    if (at < 0) return 'gone'
    const track = room.queue.splice(at, 1)[0]!

    const interrupted = room.current
    if (interrupted) {
      // whole seconds: a resume point is a place in a track, not a measurement
      interrupted.resumeAtSec = Math.max(0, Math.floor(this.positionSec(room)))
      room.queue.unshift(interrupted)
    }

    this.clearEnd(room)
    this.startTrack(room, track)
    this.emit(room, { kind: 'skip', actor: actor ?? track.requestedBy, actorId, detail: track.title })
    this.broadcast(room)
    this.lifecycle?.onAdvance(groupId, {
      finished: interrupted ? this.cardTrack(interrupted) : null,
      next: this.cardTrack(track),
      reason: 'postponed',
      by: actor ? { name: actor, id: actorId } : undefined,
      resumeAtSec: interrupted?.resumeAtSec,
    })
    return 'ok'
  }

  /** Drop a queued track and throw its media away. Never touches what is playing. */
  async removeQueued(groupId: string, trackId: string): Promise<boolean> {
    const room = this.rooms.get(groupId)
    if (!room) return false
    const at = room.queue.findIndex((t) => t.id === trackId)
    if (at < 0) return false
    const [gone] = room.queue.splice(at, 1)
    this.broadcast(room)
    await gone?.dispose().catch(() => {})
    return true
  }

  play(groupId: string, actor?: string, actorId?: string): 'ok' | 'nothing' | 'already' {
    const room = this.rooms.get(groupId)
    if (!room?.current) return 'nothing'
    if (room.playing) return 'already'
    room.autoPaused = false
    room.startedAt = Date.now() - room.pausedPositionSec * 1000
    room.playing = true
    this.resumeTrackSession(room)
    this.scheduleEnd(room)
    if (actor) this.emit(room, { kind: 'resume', actor, actorId })
    this.broadcast(room)
    this.lifecycle?.onTransport?.(room.groupId)
    return 'ok'
  }

  pause(groupId: string, actor?: string, actorId?: string): 'ok' | 'nothing' | 'already' {
    const room = this.rooms.get(groupId)
    if (!room?.current) return 'nothing'
    if (!room.playing) return 'already'
    if (actorId !== 'auto_empty') {
      room.autoPaused = false
    }
    room.pausedPositionSec = this.positionSec(room)
    room.playing = false
    this.pauseTrackSession(room)
    this.clearEnd(room)
    if (actor) this.emit(room, { kind: 'pause', actor, actorId })
    this.broadcast(room)
    this.lifecycle?.onTransport?.(room.groupId)
    return 'ok'
  }

  seek(groupId: string, positionSec: number, actor?: string, actorId?: string): 'nothing' | 'live' | number {
    const room = this.rooms.get(groupId)
    if (!room?.current) return 'nothing'
    const duration = room.current.duration
    if (duration == null || duration <= 0) return 'live'
    const target = Math.max(0, Math.min(Math.floor(positionSec), Math.max(0, Math.floor(duration) - 1)))
    if (room.playing) {
      room.startedAt = Date.now() - target * 1000
      this.scheduleEnd(room)
    } else {
      room.pausedPositionSec = target
    }
    if (actor) this.emit(room, { kind: 'seek', actor, actorId, detail: formatClock(target) })
    this.broadcast(room)
    this.lifecycle?.onTransport?.(room.groupId)
    return target
  }

  skip(groupId: string, actor?: string, actorId?: string, fromWeb = false): 'skipped' | 'skipped_last' | 'nothing' {
    const room = this.rooms.get(groupId)
    if (!room?.current) return 'nothing'
    const hadNext = room.queue.length > 0
    if (actor) this.emit(room, { kind: 'skip', actor, actorId })
    room.loopRemaining = 0
    if (fromWeb && actor) {
      const icon = md(emojiTag('⏭️', TEXT_SKIP_EMOJI_ID))
      this.notifyGroup(groupId, md`${icon} Skipped by ${this.mentionOrYou(groupId, actor, actorId)}.`)
    }
    void this.advance(room, 'skip')
    return hadNext ? 'skipped' : 'skipped_last'
  }

  setLoop(groupId: string, count: number): 'ok' | 'nothing' {
    const room = this.rooms.get(groupId)
    if (!room?.current) return 'nothing'
    room.loopRemaining = Math.max(0, Math.floor(count))
    return 'ok'
  }

  async clearQueue(groupId: string, actor?: string, actorId?: string): Promise<boolean> {
    const room = this.rooms.get(groupId)
    if (!room || room.queue.length === 0) return false
    if (actor) this.emit(room, { kind: 'clear', actor, actorId })
    const toDispose = room.queue
    room.queue = []
    this.broadcast(room)
    await Promise.all(toDispose.map((t) => t.dispose().catch(() => {})))
    return true
  }

  async end(groupId: string, actor?: string, actorId?: string): Promise<boolean> {
    const room = this.rooms.get(groupId)
    if (!room?.current && !room?.queue.length) return false
    if (actor) this.emit(room, { kind: 'clear', actor, actorId })
    this.clearEnd(room)
    const toDispose = [room.current, ...room.queue].filter(Boolean) as InternalTrack[]
    room.current = null
    room.queue = []
    room.playing = false
    room.pausedPositionSec = 0
    this.broadcast(room)
    await Promise.all(toDispose.map((t) => t.dispose().catch(() => {})))
    return true
  }

  async reboot(groupId: string): Promise<boolean> {
    const room = this.rooms.get(groupId)
    if (!room) return false
    this.clearEnd(room)
    const toDispose = [room.current, ...room.queue].filter(Boolean) as InternalTrack[]
    for (const c of room.connections.values()) {
      try {
        c.ws.send(JSON.stringify({ type: 'closed', reason: 'rebooted' } satisfies ServerMessage))
      } catch {
      }
      try {
        c.ws.close(4001, 'rebooted')
      } catch {
      }
    }
    room.connections.clear()
    this.rooms.delete(groupId)
    await Promise.all(toDispose.map((t) => t.dispose().catch(() => {})))
    return true
  }

  getSnapshot(groupId: string): RoomSnapshot | null {
    const room = this.rooms.get(groupId)
    return room ? this.buildSnapshot(room) : null
  }

  isActive(groupId: string): boolean {
    return !!this.rooms.get(groupId)?.current
  }

  async shutdown(): Promise<void> {
    this.stopPoseLoop()
    const all = [...this.rooms.values()]
    for (const room of all) {
      this.clearEnd(room)
      for (const c of room.connections.values()) c.ws.close(1001, 'server shutting down')
    }
    await Promise.all(
      all.flatMap((room) =>
        [room.current, ...room.queue]
          .filter(Boolean)
          .map((t) => (t as InternalTrack).dispose().catch(() => {})),
      ),
    )
    this.rooms.clear()
  }

  private initTrackSession(room: Room, track: InternalTrack): void {
    const durationSec = track.duration && track.duration > 0 ? track.duration : 0
    const listeners = new Map<string, ListenerTracking>()
    const now = Date.now()

    for (const c of room.connections.values()) {
      const uid = Number(c.participant.id)
      if (isNaN(uid) || uid <= 0) continue
      const strUid = String(uid)
      if (!listeners.has(strUid)) {
        listeners.set(strUid, {
          userId: uid,
          profile: {
            username: c.participant.username,
            firstName: c.participant.name,
          },
          activeSince: room.playing ? now : null,
          accumulatedMs: 0,
        })
      }
    }

    room.trackSession = {
      trackId: track.id,
      title: track.title,
      durationSec,
      requesterId: track.requestedById,
      requesterName: track.requestedBy,
      listeners,
    }
  }

  private pauseTrackSession(room: Room): void {
    const session = room.trackSession
    if (!session) return
    const now = Date.now()
    for (const l of session.listeners.values()) {
      if (l.activeSince != null) {
        l.accumulatedMs += Math.max(0, now - l.activeSince)
        l.activeSince = null
      }
    }
  }

  private resumeTrackSession(room: Room): void {
    const session = room.trackSession
    if (!session) return
    const now = Date.now()
    for (const c of room.connections.values()) {
      const uid = Number(c.participant.id)
      if (isNaN(uid) || uid <= 0) continue
      const strUid = String(uid)
      let l = session.listeners.get(strUid)
      if (!l) {
        l = {
          userId: uid,
          profile: {
            username: c.participant.username,
            firstName: c.participant.name,
          },
          activeSince: now,
          accumulatedMs: 0,
        }
        session.listeners.set(strUid, l)
      } else {
        l.activeSince = now
      }
    }
  }

  private onConnectionJoin(room: Room, participant: RoomParticipant): void {
    const session = room.trackSession
    if (!session || !room.playing) return
    const uid = Number(participant.id)
    if (isNaN(uid) || uid <= 0) return
    const strUid = String(uid)
    let l = session.listeners.get(strUid)
    if (!l) {
      session.listeners.set(strUid, {
        userId: uid,
        profile: {
          username: participant.username,
          firstName: participant.name,
        },
        activeSince: Date.now(),
        accumulatedMs: 0,
      })
    } else if (l.activeSince == null) {
      l.activeSince = Date.now()
    }
  }

  private checkAndCreditListeners(room: Room, finishedTrack?: InternalTrack | null): void {
    const session = room.trackSession
    if (!session) return

    const durationSec = finishedTrack?.duration ?? session.durationSec
    if (!durationSec || durationSec < 5) return

    const halfDurationSec = Math.max(3, Math.floor(durationSec / 2))
    const now = Date.now()
    const numericGroupId = Number(room.groupId)
    if (isNaN(numericGroupId)) return

    const reqUid = session.requesterId ? Number(session.requesterId) : NaN

    for (const l of session.listeners.values()) {
      if (l.credited) continue
      if (botInfo.id && l.userId === botInfo.id) continue
      let totalMs = l.accumulatedMs
      if (l.activeSince != null) {
        totalMs += Math.max(0, now - l.activeSince)
      }
      const listenedSec = Math.floor(totalMs / 1000)
      if (listenedSec >= halfDurationSec) {
        l.credited = true
        const isRequester = !isNaN(reqUid) && l.userId === reqUid
        void recordTrackListen(
          numericGroupId,
          l.userId,
          {
            id: session.trackId,
            title: session.title,
            duration: durationSec,
          },
          listenedSec,
          l.profile,
          { isRequester },
        ).then(async (res) => {
          if (res.milestoneLevel) {
            await notifyLevelUp(numericGroupId, l.userId, l.profile, res.milestoneLevel)
          }
        }).catch((err) => {
          console.error(`[ranking] Failed to record track listen for user ${l.userId}:`, err)
        })
      }
    }
  }

  private onConnectionLeave(room: Room, userIdStr: string): void {
    const session = room.trackSession
    if (!session) return
    const stillPresent = [...room.connections.values()].some((c) => c.participant.id === userIdStr)
    if (stillPresent) return

    const l = session.listeners.get(userIdStr)
    if (l && l.activeSince != null) {
      l.accumulatedMs += Math.max(0, Date.now() - l.activeSince)
      l.activeSince = null
      this.checkAndCreditListeners(room)
    }
  }

  private finalizeTrackSession(room: Room, finishedTrack?: InternalTrack | null): void {
    const session = room.trackSession
    if (!session) return
    this.checkAndCreditListeners(room, finishedTrack)
    room.trackSession = null
  }

  private startTrack(room: Room, track: InternalTrack): void {
    track.mediaId = randomUUID()
    track.mediaUrl = `${config.room.publicUrl}/media/${encodeURIComponent(room.groupId)}/${track.mediaId}`
    room.current = track
    room.playing = true
    /*
      An interrupted track resumes where it stopped.

      Position is derived from `startedAt`, so resuming is a matter of claiming
      the track started earlier than it did. Everything downstream - the
      scrubber, the end timer, the snapshot - reads the same clock and needs to
      know nothing about any of this.
    */
    const resumeAt = track.resumeAtSec ?? 0
    track.resumeAtSec = undefined
    room.startedAt = Date.now() - resumeAt * 1000
    recordTrackPlayed()
    logger.trackPlayed({
      track: track.title,
      room: room.title ?? room.roomName ?? 'Room',
      video: track.video,
      playedBy: track.requestedBy,
      duration: track.duration,
    })
    room.pausedPositionSec = resumeAt
    room.loopRemaining = 0
    this.initTrackSession(room, track)
    this.scheduleEnd(room)

    if ((track.duration == null || track.duration <= 0) && track.mediaFsPath) {
      void probeMediaDuration(track.mediaFsPath).then((dur) => {
        if (dur && room.current?.id === track.id) {
          track.duration = dur
          if (room.trackSession) room.trackSession.durationSec = dur
          this.scheduleEnd(room)
          this.broadcast(room)
          this.lifecycle?.onTransport?.(room.groupId)
        }
      })
    }

    room.trackHadPresence = room.connections.size > 0

    const vid = track.sourceUrl
      ? extractVideoId(track.sourceUrl)
      : (track.id.length === 11 ? track.id : null)
    room.recentTrackHistory ??= []
    room.recentTrackHistory.unshift({ id: vid, title: track.title, uploader: track.artist })
    if (room.recentTrackHistory.length > 5) room.recentTrackHistory.length = 5

    for (const c of room.connections.values()) {
      c.videoUrl = undefined
      c.videoUrlTrackId = undefined
    }
    if (track.sourceMode === 'split') {
      queueMicrotask(() => this.refreshAllParticipantVideos(room.groupId))
      const ladderTrackId = track.id
      const timer = setTimeout(() => void this.mintQualityLadder(room.groupId, ladderTrackId), 2500)
      timer.unref?.()
    }

    // Prefetch recommendations and pre-download next track in background
    queueMicrotask(() => this.prefetchRecommendationsAndMedia(room))
  }

  private async prefetchRecommendationsAndMedia(room: Room): Promise<void> {
    if (!room.recentTrackHistory || room.recentTrackHistory.length === 0) return
    try {
      const recs = await getRecommendedTracks(
        room.recentTrackHistory,
        { limit: 10, excludeIds: room.recentTrackIds },
      )
      if (recs.length === 0) return
      room.prefetchedRecommendations = recs

      // If autoplay is ON and queue is currently empty, pre-download the audio
      if (room.autoplay === true && room.queue.length === 0) {
        const top = recs[0]!
        const isVideo = room.current?.video === true
        if (room.prefetchedMedia?.track.id === top.id && room.prefetchedMedia?.video === isVideo) return

        room.prefetchedMedia = {
          track: top,
          video: isVideo,
          audioPromise: defuse(acquireAudio(tg, dp.deps.db, top)),
          videoDirectPromise: isVideo ? defuse(getDirectVideoUrl(top, 1080)) : undefined,
        }
      }
    } catch {
    }
  }

  private async advance(room: Room, reason: 'natural' | 'skip' = 'natural'): Promise<void> {
    this.clearEnd(room)
    const finished = room.current
    this.finalizeTrackSession(room, finished)

    if (finished) {
      const vid = finished.sourceUrl
        ? extractVideoId(finished.sourceUrl)
        : (finished.id.length === 11 ? finished.id : null)
      if (vid) {
        room.recentTrackIds ??= []
        room.recentTrackIds.push(vid)
        while (room.recentTrackIds.length > 50) room.recentTrackIds.shift()
      }
    }

    const next = room.queue.shift() ?? null
    if (next) {
      if (room.prefetchedMedia) {
        const pm = room.prefetchedMedia
        room.prefetchedMedia = undefined
        pm.audioPromise.then((m) => m.dispose()).catch(() => {})
        pm.videoDirectPromise?.catch(() => {})
      }

      if (!next.mediaFsPath && next.acquireMedia) {
        try {
          const m = await next.acquireMedia()
          next.mediaFsPath = m.path
          next.dispose = m.dispose
        } catch (err) {
          console.error('Failed to acquire media for next track in queue:', err)
          return this.advance(room, reason)
        }
      }
      this.startTrack(room, next)
      this.prefetchNext(room)
    } else {
      room.current = null
      room.playing = false
      room.pausedPositionSec = 0
    }
    this.broadcast(room)
    this.lifecycle?.onAdvance(room.groupId, {
      finished: finished ? this.cardTrack(finished) : null,
      next: next ? this.cardTrack(next) : null,
      reason,
    })
    if (finished) await finished.dispose().catch(() => {})

    const hadPresence = room.trackHadPresence === true || room.connections.size > 0
    room.trackHadPresence = room.connections.size > 0

    if (!next && room.autoplay === true && finished && hadPresence) {
      void this.triggerAutoplay(room, finished, reason === 'skip')
    }
  }

  private async triggerAutoplay(room: Room, finished: InternalTrack, isSkip = false): Promise<void> {
    if (room.autoplayAcquiring || room.current || room.queue.length > 0) return
    room.autoplayAcquiring = true
    try {
      const isVideo = finished.video === true
      let pick: ResolvedTrack | null = null
      let audioPromise: Promise<{ path: string; dispose: () => Promise<void> }> | null = null
      let videoDirectPromise: Promise<{ url: string; height: number | null }> | null = null
      let isPreDownloaded = false

      if (room.prefetchedMedia && room.prefetchedMedia.track) {
        if (room.prefetchedMedia.video === isVideo) {
          pick = room.prefetchedMedia.track
          audioPromise = room.prefetchedMedia.audioPromise
          videoDirectPromise = room.prefetchedMedia.videoDirectPromise ?? null
          isPreDownloaded = true
          room.prefetchedMedia = undefined
        } else {
          const pm = room.prefetchedMedia
          room.prefetchedMedia = undefined
          pm.audioPromise.then((m) => m.dispose()).catch(() => {})
          pm.videoDirectPromise?.catch(() => {})
        }
      }

      if (!pick) {
        const recs = room.prefetchedRecommendations?.length
          ? room.prefetchedRecommendations
          : await getRecommendedTracks(
              room.recentTrackHistory && room.recentTrackHistory.length > 0
                ? room.recentTrackHistory
                : [{ id: finished.sourceUrl ? extractVideoId(finished.sourceUrl) : null, title: finished.title, uploader: finished.artist }],
              { limit: 5, excludeIds: room.recentTrackIds },
            )
        if (!recs || recs.length === 0) return
        pick = recs[0]!
        audioPromise = defuse(acquireAudio(tg, dp.deps.db, pick))
        if (isVideo) {
          videoDirectPromise = defuse(getDirectVideoUrl(pick, 1080))
        }
      }
      if (!pick || !audioPromise) return

      if (room.current || room.queue.length > 0) return

      const botName = botInfo.displayName || 'Playeon'
      const botId = botInfo.id ? String(botInfo.id) : undefined

      let statusMessageId: number | undefined
      if (isSkip && !isPreDownloaded) {
        const info: CardInfo = {
          title: pick.title,
          sourceUrl: pick.url,
          duration: pick.duration,
          requestedBy: botName,
          requestedById: botId ?? '',
          video: isVideo,
          thumbnail: pick.thumbnail,
        }
        const embed = coverEmbed(pick.thumbnail)
        const sent = await tg
          .sendText(Number(room.groupId), downloadingCard(info, { percent: 45 }), {
            invertMedia: embed,
            disableWebPreview: !embed,
          })
          .catch(() => null)
        if (sent) statusMessageId = sent.id
      }

      const [audio, direct] = await Promise.all([
        audioPromise,
        isVideo ? (videoDirectPromise ?? defuse(getDirectVideoUrl(pick, 1080))) : Promise.resolve(null),
      ])

      if (room.current || room.queue.length > 0) {
        await audio.dispose().catch(() => {})
        if (statusMessageId) void tg.deleteMessagesById(Number(room.groupId), [statusMessageId]).catch(() => {})
        return
      }

      const maxHeight = 1080
      const { trackId } = this.enqueue({
        groupId: room.groupId,
        title: pick.title,
        artist: pick.uploader ?? null,
        artistAvatar: pick.artistAvatar ?? null,
        lyricsArtist: pick.credits ?? null,
        duration: pick.duration,
        sourceUrl: pick.url,
        thumbnail: pick.thumbnail,
        video: isVideo,
        requestedBy: botName,
        requestedById: undefined,
        mediaFsPath: audio.path,
        dispose: audio.dispose,
        sourceMode: isVideo ? 'split' : 'download',
        videoDirectUrl: isVideo && direct ? direct.url : undefined,
        videoSourceUrl: isVideo ? pick.url : undefined,
        videoMaxHeight: isVideo ? maxHeight : undefined,
        cardVideoHeight: isVideo && direct ? (direct.height ?? maxHeight) : undefined,
        statusMessageId,
      })

      const activeRoom = this.rooms.get(room.groupId)
      const cur = activeRoom?.current
      if (trackId && cur && cur.id === trackId) {
        this.lifecycle?.onAdvance(room.groupId, {
          finished: null,
          next: this.cardTrack(cur),
          reason: 'natural',
        })
      }
    } catch (err) {
      console.error('[autoplay] Failed to trigger recommendation:', err)
    } finally {
      room.autoplayAcquiring = false
    }
  }

  private prefetchNext(room: Room): void {
    const next = room.queue[0]
    if (next && !next.mediaFsPath && next.acquireMedia) {
      const p = next.acquireMedia()
      p.then((m) => {
        next.mediaFsPath = m.path
        next.dispose = m.dispose
      }).catch(() => {})
    } else if (room.queue.length === 0 && room.autoplay === true) {
      queueMicrotask(() => this.prefetchRecommendationsAndMedia(room))
    }
  }

  private scheduleEnd(room: Room): void {
    this.clearEnd(room)
    const cur = room.current
    if (!cur || !room.playing) return
    const duration = cur.duration
    if (duration == null || duration <= 0) return
    const remainingMs = Math.max(0, (duration - this.positionSec(room)) * 1000)
    room.endTimer = setTimeout(() => {
      room.endTimer = null
      if (room.loopRemaining > 0 && room.current) {
        room.loopRemaining -= 1
        this.restartCurrent(room)
      } else {
        void this.advance(room)
      }
    }, remainingMs)
    room.endTimer.unref?.()
  }

  private restartCurrent(room: Room): void {
    if (!room.current) return
    this.finalizeTrackSession(room, room.current)
    room.startedAt = Date.now()
    room.pausedPositionSec = 0
    room.playing = true
    this.initTrackSession(room, room.current)
    this.scheduleEnd(room)
    this.broadcast(room)
  }

  private clearEnd(room: Room): void {
    if (room.endTimer) {
      clearTimeout(room.endTimer)
      room.endTimer = null
    }
  }

  private toPublicTrack(t: InternalTrack, isCurrent: boolean, groupId: string): RoomTrack {
    return {
      id: t.id,
      title: t.title,
      artist: t.artist ?? null,
      artistAvatar: t.artistAvatar ?? null,
      lyricsArtist: t.lyricsArtist ?? null,
      duration: t.duration,
      /*
        The track's own page, carried on the snapshot.

        Left off for a long time, which is why every title the room reported was
        plain text: the cards ask for a link and the snapshot never had one to
        give. Safe to publish, unlike the media URLs below it - this is the
        public page the track came from, the same address the person who queued
        it pasted in.
      */
      sourceUrl: t.sourceUrl ?? null,
      thumbnail: t.thumbnail,
      video: t.video,
      requestedBy: t.requestedBy,
      requestedById: t.requestedById,
      mediaUrl: isCurrent ? t.mediaUrl : undefined,
      sourceMode: t.sourceMode,
      videoUrl:
        isCurrent && !config.room.perParticipantVideoUrl ? t.videoDirectUrl : undefined,
      // Advertised to everyone and used by the 3D lounge alone. It carries no
      // mint of its own - the route resolves that per request, so this URL
      // survives every re-mint the track goes through.
      videoProxyUrl:
        isCurrent && t.sourceMode === 'split'
          ? `${config.room.publicUrl}/video/${encodeURIComponent(groupId)}/${encodeURIComponent(t.id)}`
          : undefined,
      videoQualities: isCurrent ? t.videoQualities : undefined,
      statusMessageId: t.statusMessageId,
    }
  }

  private buildSnapshot(room: Room): RoomSnapshot {
    room.rev += 1
    const participants = [...room.connections.values()].map((c) => c.participant)
    const byUser = new Map<string, RoomParticipant>()
    for (const p of participants) {
      const existing = byUser.get(p.id)
      byUser.set(p.id, {
        ...p,
        online: true,
        present: (existing?.present ?? false) || p.present,
      })
    }
    return {
      type: 'snapshot',
      rev: room.rev,
      groupId: room.groupId,
      title: room.title,
      roomName: room.roomName,
      avatarUrl: room.avatarUrl,
      current: room.current ? this.toPublicTrack(room.current, true, room.groupId) : null,
      playing: room.playing,
      startedAt: room.startedAt,
      pausedPositionSec: room.playing ? this.positionSec(room) : room.pausedPositionSec,
      queue: room.queue.map((t) => this.toPublicTrack(t, false, room.groupId)),
      participants: [...byUser.values()],
      serverTime: Date.now(),
      // Only once somebody has touched a switch. Absent is "all on", so an
      // untouched room says nothing rather than describing a default.
      lights: room.lights ? [...room.lights] : undefined,
    }
  }

  private broadcast(room: Room): void {
    const base = this.buildSnapshot(room)
    const baseJson = JSON.stringify(base)
    for (const c of room.connections.values()) {
      if (c.ws.readyState !== c.ws.OPEN) continue
      const payload = this.snapshotPayloadFor(base, baseJson, c)
      if (payload == null) continue
      try {
        c.ws.send(payload)
      } catch {
      }
    }
  }

  private sendSnapshotToConn(room: Room, conn: Connection): void {
    if (conn.ws.readyState !== conn.ws.OPEN) return
    const base = this.buildSnapshot(room)
    const payload = this.snapshotPayloadFor(base, JSON.stringify(base), conn)
    if (payload == null) return
    try {
      conn.ws.send(payload)
    } catch {
    }
  }

  private snapshotPayloadFor(base: RoomSnapshot, baseJson: string, conn: Connection): string | null {
    if (config.room.perParticipantVideoUrl && base.current?.sourceMode === 'split') {
      if (conn.videoUrl && conn.videoUrlTrackId === base.current.id) {
        return JSON.stringify({ ...base, current: { ...base.current, videoUrl: conn.videoUrl } })
      }
      return null
    }
    return baseJson
  }

  private emit(room: Room, ev: Omit<RoomEvent, 'type' | 'at'>): void {
    this.send(room, { type: 'event', at: Date.now(), ...ev })
  }

  private send(room: Room, message: ServerMessage): void {
    const payload = JSON.stringify(message)
    for (const c of room.connections.values()) {
      if (c.ws.readyState === c.ws.OPEN) {
        try {
          c.ws.send(payload)
        } catch {
        }
      }
    }
  }
}

export const roomManager = new RoomManagerImpl()
