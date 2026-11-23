import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client, Events, GatewayIntentBits, Routes, SlashCommandBuilder } from 'discord.js'
import type { Attachment, Message } from 'discord.js'
import { fetch } from 'undici'
import type { ProxyAgent } from 'undici'
import type { Config } from '../service/config.ts'
import type { ChannelQueue, Log, TurnHandler } from '../memory/turns.ts'
import type { ServiceState } from '../storage/service-state.ts'
import { CodexFailure, sessionPattern } from './codex.ts'
import { configureDiscordProxy } from './discord-proxy.ts'

const maxImages = 4
const maxBytes = 10 * 1024 * 1024
const imageTypes = new Map([
  ['image/jpeg', '.jpg'], ['image/png', '.png'], ['image/webp', '.webp'],
])
const mentionPolicy = { parse: [], repliedUser: false } as const
const commands = [
  new SlashCommandBuilder().setName('new').setDescription('Start a fresh SoXin conversation'),
  new SlashCommandBuilder().setName('resume').setDescription('List or resume earlier SoXin conversations in this channel')
    .addStringOption(option => option.setName('session').setDescription('A session ID from this channel').setMaxLength(36)),
]

export function admitted(settings: Config['discord'], user: string, channel: string) {
  return user === settings.allowedUser && settings.allowedChannels.includes(channel)
}

export function splitReply(text: string, limit = 2000) {
  const parts: string[] = []
  let rest = text.trim()
  while (rest.length > limit) {
    const line = rest.lastIndexOf('\n', limit - 1)
    let end = line > limit / 2 ? line : limit
    if (/[\uD800-\uDBFF]/.test(rest[end - 1])) end--
    parts.push(rest.slice(0, end))
    rest = rest.slice(end).trimStart()
  }
  if (rest) parts.push(rest)
  return parts
}

function extension(attachment: Attachment) {
  const type = attachment.contentType?.split(';', 1)[0].toLowerCase()
  return type ? imageTypes.get(type) : undefined
}

function validImage(data: Buffer, suffix: string) {
  if (suffix === '.jpg') return data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff
  if (suffix === '.png') return data.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
  return data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP'
}

async function download(attachment: Attachment, suffix: string, dispatcher?: ProxyAgent) {
  const url = new URL(attachment.url)
  if (url.protocol !== 'https:' || !['cdn.discordapp.com', 'media.discordapp.net'].includes(url.hostname)) {
    throw new Error('Unexpected attachment host')
  }
  const response = await fetch(url, { dispatcher, redirect: 'error', signal: AbortSignal.timeout(15000) })
  if (!response.ok || !response.body) throw new Error('Attachment unavailable')
  const reader = response.body.getReader()
  const chunks = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > maxBytes) throw new Error('Image too large')
      chunks.push(Buffer.from(value))
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
  const data = Buffer.concat(chunks)
  if (!validImage(data, suffix)) throw new Error('Invalid image')
  return data
}

type DiscordStatus = 'disabled' | 'connecting' | 'connected' | 'disconnected'

function loginFailure(error: unknown, proxied: boolean) {
  const failure = error as { message?: string, code?: string, status?: number } | undefined
  if (/disallowed intents/i.test(failure?.message ?? '')) {
    return 'Discord rejected Message Content Intent. Enable it for this bot in the Discord Developer Portal.'
  }
  if (failure?.code === 'TokenInvalid' || failure?.status === 401 || /authentication failed/i.test(failure?.message ?? '')) {
    return 'Discord rejected the bot token. Check DISCORD_BOT_TOKEN.'
  }
  return proxied
    ? 'Could not connect to Discord. Check DISCORD_PROXY_URL and whether the proxy is running.'
    : 'Could not connect to Discord. Set DISCORD_PROXY_URL if your network requires an HTTP proxy.'
}

export function connectDiscord(
  settings: Config['discord'], token: string | undefined, queue: ChannelQueue, handler: TurnHandler,
  state: ServiceState, log: Log, proxyUrl?: string,
) {
  let status: DiscordStatus = token ? 'connecting' : 'disabled'
  let accepting = true
  let client: Client | undefined
  let dispatcher: ProxyAgent | undefined

  if (token && settings.allowedUser && settings.allowedChannels.length && proxyUrl) {
    try {
      dispatcher = configureDiscordProxy(proxyUrl)
    } catch {
      status = 'disconnected'
      token = undefined
      log('Invalid DISCORD_PROXY_URL. Use an HTTP proxy URL such as http://127.0.0.1:7890.')
    }
  }

  if (token && settings.allowedUser && settings.allowedChannels.length) {
    const bot = new Client({
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
      allowedMentions: { parse: [], repliedUser: false },
    })
    if (dispatcher) bot.rest.setAgent(dispatcher)
    client = bot

    async function process(message: Message<true>) {
      let directory: string | undefined
      const images: string[] = []
      let ignored = 0
      try {
        for (const attachment of message.attachments.values()) {
          const suffix = extension(attachment)
          if (!suffix || attachment.size > maxBytes || images.length >= maxImages) {
            ignored++
            continue
          }
          directory ??= await mkdtemp(join(tmpdir(), 'soxin-images-'))
          const path = join(directory, 'image-' + images.length + suffix)
          try {
            await writeFile(path, await download(attachment, suffix, dispatcher), { mode: 0o600 })
            images.push(path)
          } catch {
            ignored++
            log('Discord attachment could not be loaded')
          }
        }
        const attachmentWarning = ignored ? 'Some attachments could not be used. Send up to four PNG, JPEG or WebP images, each no larger than 10 MiB.' : ''
        if (!message.content.trim() && !images.length) {
          if (attachmentWarning) await message.reply(attachmentWarning)
          return
        }
        let reply
        try {
          reply = await handler.handle({
            sourceId: message.id, channelId: message.channelId, userId: message.author.id,
            timestamp: message.createdAt.toISOString(), text: message.content, images,
          })
        } catch (error) {
          log('Discord turn failed')
          await message.reply(error instanceof CodexFailure ? error.message : 'SoXin could not finish the turn. Check the service log.')
          return
        }
        const parts = splitReply([reply.text, reply.warning, attachmentWarning].filter(Boolean).join('\n\n'))
        for (const [index, content] of parts.entries()) {
          try {
            await message.channel.send({ content, allowedMentions: { ...mentionPolicy, parse: [] }, nonce: message.id + String(index), enforceNonce: true })
          } catch {
            await message.channel.send({ content, allowedMentions: { ...mentionPolicy, parse: [] }, nonce: message.id + String(index), enforceNonce: true })
          }
        }
      } finally {
        if (directory) await rm(directory, { recursive: true, force: true })
      }
    }

    bot.on(Events.MessageCreate, message => {
      if (!accepting || !message.inGuild() || message.author.bot || !admitted(settings, message.author.id, message.channelId)) return
      void queue.run(message.channelId, () => process(message)).catch(() => log('Discord message delivery failed'))
    })

    bot.on(Events.InteractionCreate, interaction => {
      if (!accepting || !interaction.isChatInputCommand() || !commands.some(command => command.name === interaction.commandName)) return
      if (!admitted(settings, interaction.user.id, interaction.channelId)) {
        void interaction.reply({ content: 'SoXin is unavailable in this channel.', flags: 'Ephemeral' })
          .catch(() => log('Discord command response failed'))
        return
      }
      const acknowledgement = interaction.deferReply({ flags: 'Ephemeral' })
      void acknowledgement.catch(() => {})
      void queue.run(interaction.channelId, async () => {
        await acknowledgement
        const channel = interaction.channelId
        if (interaction.commandName === 'new') {
          state.newSession(channel)
          await interaction.editReply('A fresh conversation will start with your next message.')
          return
        }
        const id = interaction.options.getString('session')?.trim().toLowerCase()
        if (id) {
          const ok = sessionPattern.test(id) && state.resume(channel, id)
          await interaction.editReply(ok ? 'Conversation selected.' : 'That session does not belong to this channel. Use /resume to see available sessions.')
          return
        }
        const active = state.active(channel)
        const sessions = state.sessions(channel).map(item =>
          '`' + item.id + '` · ' + item.lastUsed.slice(0, 10) + (item.id === active ? ' · active' : ''),
        )
        await interaction.editReply(sessions.length
          ? 'Pass a session ID to /resume to select it.\n' + sessions.join('\n')
          : 'This channel has no saved conversations.')
      }).catch(() => log('Discord command failed'))
    })

    bot.on(Events.ClientReady, ready => {
      status = 'connected'
      void (async () => {
        const guilds = new Set<string>()
        for (const id of settings.allowedChannels) {
          try {
            const channel = await ready.channels.fetch(id)
            if (channel && !channel.isDMBased()) guilds.add(channel.guildId)
            else log('A configured Discord channel is unavailable')
          } catch {
            log('A configured Discord channel is unavailable')
          }
        }
        for (const guild of guilds) {
          for (const command of commands) {
            try {
              await ready.rest.post(Routes.applicationGuildCommands(ready.application.id, guild), { body: command.toJSON() })
            } catch {
              log('Discord slash command registration failed')
            }
          }
        }
      })().catch(() => log('Discord setup failed'))
    })
    bot.on(Events.ShardDisconnect, () => { status = 'disconnected' })
    bot.on(Events.ShardResume, () => { status = 'connected' })
    bot.on(Events.ShardError, () => log('Discord connection error'))
    bot.on(Events.Error, () => log('Discord client error'))
    void bot.login(token).catch(error => {
      status = 'disconnected'
      log(loginFailure(error, !!dispatcher))
      void bot.destroy().catch(() => {})
    })
  } else if (token) {
    status = 'disabled'
    log('Discord is disabled until an allowed user and channel are configured')
  }

  return {
    status: () => status,
    async close() {
      accepting = false
      await queue.drain()
      try {
        await client?.destroy()
      } finally {
        await dispatcher?.close()
      }
    },
  }
}
