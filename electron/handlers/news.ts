import { ipcMain } from 'electron'
import Parser from 'rss-parser'
import logger from 'electron-log/main'
import https from 'node:https'

type RssFeedItem = {
  title?: string
  link?: string
  content?: string
  contentSnippet?: string
  pubDate?: string
  isoDate?: string
  enclosure?: {
    url?: string
  }
  'content:encoded'?: string
  'media:content'?: {
    $?: {
      url?: string
    }
    url?: string
  }
  'media:thumbnail'?: {
    $?: {
      url?: string
    }
    url?: string
  }
}

export type RssNewsArticle = {
  title: string
  description: string
  link: string
  image: string | null
  publishedAt: string
}

const RSS_URL = 'https://mcflowblock.com/api/rss'

const parser = new Parser<Record<string, never>, RssFeedItem>({
  customFields: {
    item: ['content:encoded', 'media:content', 'media:thumbnail']
  }
})

function stripHtmlTags(value: string) {
  return value.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
}

function extractFirstImageFromHtml(value: string) {
  const match = /<img[^>]+src=["']([^"']+)["']/i.exec(value)
  return match?.[1] ?? null
}

function mapRssItemToArticle(item: RssFeedItem): RssNewsArticle | null {
  const rawHtml = item['content:encoded'] ?? item.content ?? ''
  const description = item.contentSnippet?.trim() || stripHtmlTags(rawHtml).slice(0, 220)
  const image =
    item['media:content']?.$?.url ??
    item['media:content']?.url ??
    item['media:thumbnail']?.$?.url ??
    item['media:thumbnail']?.url ??
    item.enclosure?.url ??
    extractFirstImageFromHtml(rawHtml)

  if (!item.title || !item.link) return null

  return {
    title: item.title,
    description,
    link: item.link,
    image,
    publishedAt: item.isoDate ?? item.pubDate ?? new Date().toISOString()
  }
}

function decodeXmlEntities(value: string) {
  return value
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
}

function extractTagValue(block: string, tagName: string) {
  const escapedTag = tagName.replace(':', '\\:')
  const match = new RegExp(`<${escapedTag}>([\\s\\S]*?)<\\/${escapedTag}>`, 'i').exec(block)
  return match?.[1]?.trim() ?? ''
}

function extractEnclosureUrl(block: string) {
  const match = /<enclosure[^>]*url=["']([^"']+)["'][^>]*>/i.exec(block)
  return match?.[1] ?? ''
}

function parseRssXmlFallback(xml: string): RssNewsArticle[] {
  const itemBlocks = xml.match(/<item>[\s\S]*?<\/item>/gi) ?? []

  return itemBlocks
    .map((block) => {
      const title = decodeXmlEntities(extractTagValue(block, 'title'))
      const link = decodeXmlEntities(extractTagValue(block, 'link'))
      const description = decodeXmlEntities(extractTagValue(block, 'description'))
      const pubDate = decodeXmlEntities(extractTagValue(block, 'pubDate'))
      const encoded = decodeXmlEntities(extractTagValue(block, 'content:encoded'))
      const image = decodeXmlEntities(extractEnclosureUrl(block)) || extractFirstImageFromHtml(encoded)

      if (!title || !link) return null

      return {
        title,
        description: description || stripHtmlTags(encoded).slice(0, 220),
        link,
        image: image || null,
        publishedAt: pubDate || new Date().toISOString()
      } satisfies RssNewsArticle
    })
    .filter((item): item is RssNewsArticle => item !== null)
}

function downloadText(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          resolve(downloadText(res.headers.location))
          return
        }

        if (!res.statusCode || res.statusCode >= 400) {
          reject(new Error(`RSS HTTP error: ${res.statusCode ?? 'unknown'}`))
          return
        }

        let data = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => {
          data += chunk
        })
        res.on('end', () => resolve(data))
      })
      .on('error', reject)
  })
}

export function registerNewsHandlers() {
  ipcMain.handle('news:get_news', async () => {
    try {
      const feed = await parser.parseURL(RSS_URL)
      const parsedItems = (feed.items ?? []).map(mapRssItemToArticle).filter((item): item is RssNewsArticle => item !== null)

      if (parsedItems.length > 0) {
        logger.info(`RSS items parsed with rss-parser: ${parsedItems.length}`)
        return parsedItems
      }

      logger.warn('rss-parser returned 0 item, switching to XML fallback parser')
      const xml = await downloadText(RSS_URL)
      const fallbackItems = parseRssXmlFallback(xml)
      logger.info(`RSS items parsed with XML fallback: ${fallbackItems.length}`)
      return fallbackItems
    } catch (err) {
      logger.error('Failed to fetch news:', err)
      return []
    }
  })

  ipcMain.handle('news:get_categories', async () => {
    return []
  })
}


