// https://www.prisma.io/docs/guides/other/troubleshooting-orm/help-articles/nextjs-prisma-client-dev-practices#solution
import { Prisma, PrismaClient } from '@prisma/client'
import { ITXClientDenyList } from '@prisma/client/runtime/library.js'
import pg from 'pg'

export type {
  Document,
  User,
  YjsDocument,
  UserWorkspace,
  YjsAppDocument,
  UserYjsAppDocument,
  YjsUpdate,
  ReusableComponentInstance,
} from '@prisma/client'

export { UserWorkspaceRole } from '@prisma/client'

// TODO move these to their own package
export { encrypt, decrypt } from './datasources/crypto.js'

export * from './documents.js'
export * from './schedule.js'
export * from './datasources/index.js'
export * from './users.js'
export * from './workspaces.js'
export * from './environments.js'
export * from './components.js'

export type PrismaTransaction = Omit<PrismaClient, ITXClientDenyList>

let singleton: PrismaClient | null = null

export type InitOptions = {
  connectionString: string
  ssl:
    | 'prefer'
    | {
        rejectUnauthorized: boolean | undefined
        ca: string | undefined
      }
    | false
}
let dbOptions: InitOptions | null = null

export const init = (initOptions: InitOptions) => {
  dbOptions = initOptions
  singleton = new PrismaClient({ datasourceUrl: dbOptions.connectionString })
}

export const prisma = () => {
  if (!singleton) {
    throw new Error(`Access prisma before calling init()`)
  }

  return singleton
}

export async function recoverFromNotFound<A>(
  promise: Promise<A>
): Promise<A | null> {
  try {
    return await promise
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError) {
      if (e.code === 'P2025') {
        return null
      }
    }
    throw e
  }
}

let pgInstance: { pubSubClient: pg.Client; pool: pg.Pool } | null = null
let subscribers: Record<string, Set<(message?: string) => void>> = {}
export async function getPGInstance(): Promise<{
  pubSubClient: pg.Client
  pool: pg.Pool
}> {
  if (!dbOptions) {
    throw new Error(`Access db before calling init()`)
  }

  if (pgInstance) {
    return pgInstance
  }

  let connectionString = dbOptions.connectionString

  const ssl =
    dbOptions.ssl === 'prefer'
      ? undefined
      : dbOptions.ssl
      ? {
          rejectUnauthorized: dbOptions.ssl.rejectUnauthorized ?? undefined,
          ca: dbOptions.ssl.ca ?? undefined,
        }
      : false

  let pgPool = new pg.Pool({
    connectionString,
    ssl,
  })
  let pubSubClient = new pg.Client({
    connectionString,
    ssl,
  })

  try {
    await pubSubClient.connect()
  } catch (err) {
    if (
      dbOptions.ssl === 'prefer' &&
      err instanceof Error &&
      err.message === 'The server does not support SSL connections'
    ) {
      pgPool = new pg.Pool({
        connectionString: dbOptions.connectionString,
        ssl: false,
      })
      pubSubClient = new pg.Client({
        connectionString: dbOptions.connectionString,
        ssl: false,
      })
      await pubSubClient.connect()
    } else {
      throw err
    }
  }

  pubSubClient.on('notification', (notification) => {
    const subs = subscribers[notification.channel]
    if (!subs) {
      return
    }

    subs.forEach((sub) => {
      sub(notification.payload)
    })
  })

  pgInstance = { pubSubClient, pool: pgPool }

  return pgInstance
}

export async function subscribe(
  channel: string,
  onNotification: (message?: string) => void
): Promise<() => Promise<void>> {
  const { pubSubClient } = await getPGInstance()

  const channelLockId = hashChannel(channel)

  // Acquire the advisory lock for the channel to prevent race conditions
  // This ensures only one `LISTEN` setup happens at a time for this channel
  await pubSubClient.query('SELECT pg_advisory_lock($1)', [channelLockId])

  try {
    const subs = subscribers[channel]
    if (subs) {
      subs.add(onNotification)
    } else {
      subscribers[channel] = new Set([onNotification])

      try {
        await pubSubClient.query(`LISTEN ${JSON.stringify(channel)}`)
      } catch (e) {
        subscribers[channel].delete(onNotification)
        throw e
      }
    }
  } finally {
    // Release the advisory lock so other operations (e.g., another subscribe or unsubscribe) can proceed
    await pubSubClient.query('SELECT pg_advisory_unlock($1)', [channelLockId])
  }

  return async () => {
    // Acquire the advisory lock before making changes during unsubscribe
    // This prevents race conditions when multiple unsubscribe operations or a subscribe and unsubscribe overlap
    await pubSubClient.query('SELECT pg_advisory_lock($1)', [channelLockId])

    try {
      const subs = subscribers[channel]
      if (!subs) {
        return
      }

      subs.delete(onNotification)

      if (subs.size === 0) {
        // If this was the last subscriber, clean up by removing the channel and issuing UNLISTEN
        await pubSubClient.query(`UNLISTEN ${JSON.stringify(channel)}`)
        delete subscribers[channel]
      }
    } finally {
      // Release the advisory lock so other operations can proceed
      await pubSubClient.query('SELECT pg_advisory_unlock($1)', [channelLockId])
    }
  }
}

// PostgreSQL advisory locks require integers as lock identifiers
function hashChannel(channel: string): number {
  let hash = 0
  for (let i = 0; i < channel.length; i++) {
    hash = (hash * 31 + channel.charCodeAt(i)) | 0
  }
  return Math.abs(hash)
}

export async function getPGPool(): Promise<pg.Pool> {
  return (await getPGInstance()).pool
}

export async function publish(channel: string, message: string): Promise<void> {
  const { pubSubClient } = await getPGInstance()
  await pubSubClient.query('SELECT pg_notify($1, $2)', [channel, message])
}

export default prisma
