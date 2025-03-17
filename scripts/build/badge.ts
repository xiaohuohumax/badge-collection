import type { Badge, Collection, Example, Rule } from './schema.js'
import path from 'node:path'
import { Ajv } from 'ajv'
import ArtTemplate from 'art-template'
import fs from 'fs-extra'
import badgeSchema from '../../.vscode/schema/badge.schema.json'
import collectionSchema from '../../.vscode/schema/collection.schema.json'
import { generateToc } from '../../src/markdown.js'

const BADGE_INDEX_DEFAULT = 9999
const DO_NOT_EDIT = '<!-- 这是由脚本自动生成的文件，请勿直接修改此文件！ -->\n\n'
const ajv = new Ajv()

export interface Logger {
  log: (msg: string) => void
  warn: (msg: string) => void
  error: (msg: string) => void
}

export interface BadgeBuilderOptions {
  guideBadgeStyle?: string
  tagBadgeStyle?: string
  badgeDirPath: string
  collectionFileName: string
  tplPath: string
  tplTocTitle: string
  tplBadgeHeadingLevel: number
  examplesFoldThreshold: number
  logger: Logger
}

type RequiredKeys<O, K extends keyof O> = Required<Pick<O, K>> & Exclude<O, K>

type RenderRuleRequired = 'params' | 'querys' | 'alt'
type RenderRule = RequiredKeys<Rule, RenderRuleRequired>

interface RenderExample extends Example {
  explain: RequiredKeys<Example['explain'], 'alt'>
}

interface RenderBadge extends Badge {
  type: 'badge'
  alert?: Badge['alert'] & {
    messages: string[]
  }
  rules: RenderRule[]
  useExamples: RenderExample[]
  foldedUseExamples: RenderExample[]
  index: number
  level: number
}

interface RenderCollection extends Collection {
  type: 'collection'
  index: number
  level: number
}

type RenderItem = RenderBadge | RenderCollection

function ensureArray<T>(value: T | T[]): T[] {
  return Array.isArray(value) ? value : [value]
}

export class BadgeReadmeBuilder {
  constructor(private options: BadgeBuilderOptions) { }

  private readAndValidateJson<T>(jsonPath: string, schema: any): T | undefined {
    const json = fs.readJSONSync(jsonPath, { throws: false })

    const validate = ajv.compile(schema)
    const valid = validate(json)
    if (!valid) {
      const error = validate.errors![0]
      this.options.logger.error(`skipped "${jsonPath}": ${error.message}`)
      return
    }
    return json as T
  }

  private collection2RenderCollection(collection: Collection, level: number, index: number): RenderCollection {
    return {
      ...collection,
      type: 'collection',
      level,
      index,
    }
  }

  private badge2RenderBadge(badge: Badge, level: number, index: number): RenderBadge {
    const useExamples: RenderExample[] = badge.useExamples.map(example => ({
      ...example,
      explain: {
        ...example.explain,
        alt: example.explain.alt || 'Alt',
      },
    }))
    const foldedUseExamples = useExamples.splice(this.options.examplesFoldThreshold)
    const rules = ensureArray(badge.rules).map(rule => ({
      ...rule,
      params: rule.params || [],
      querys: rule.querys || [],
      alt: rule.alt || 'Alt',
    }))

    return {
      ...badge,
      alert: badge.alert && {
        ...badge.alert,
        messages: ensureArray(badge.alert.messages),
      },
      rules,
      useExamples,
      foldedUseExamples,
      type: 'badge',
      level,
      index,
    }
  }

  public loopReadBadgesDir(dirPath: string, deepLevel: number = 1): RenderItem[] {
    const items: RenderItem[] = []
    const files = fs.readdirSync(dirPath, { withFileTypes: true })
    const level = this.options.tplBadgeHeadingLevel + deepLevel

    if (level > 6) {
      this.options.logger.warn(`skipped "${dirPath}": heading level is too deep.`)
      return items
    }

    function getPushIndex(sortIndex: number): number {
      if (items.length === 0) {
        return 0
      }
      for (let index = 0; index < items.length; index++) {
        if (items[index].index > sortIndex) {
          return index
        }
      }
      return items.length
    }

    for (const file of files) {
      const filePath = path.join(file.parentPath, file.name)

      if (file.isDirectory()) {
        const collection = this.readAndValidateJson<Collection>(
          path.join(filePath, this.options.collectionFileName),
          collectionSchema,
        )
        if (!collection) {
          continue
        }

        if (collection.enabled === false) {
          this.options.logger.warn(`skipped "${filePath}": disabled.`)
          continue
        }

        const index = collection.index || BADGE_INDEX_DEFAULT
        const renderCollection = this.collection2RenderCollection(collection, level, index)
        const pushIndex = getPushIndex(index)

        items.splice(pushIndex, 0, renderCollection)

        const subItems = this.loopReadBadgesDir(filePath, deepLevel + 1)
        items.splice(pushIndex + 1, 0, ...subItems.map((item) => {
          item.index = index
          return item
        }))

        this.options.logger.log(`added "${filePath}".`)
      }
      else if (file.name !== this.options.collectionFileName) {
        const badge = this.readAndValidateJson<Badge>(filePath, badgeSchema)
        if (!badge) {
          continue
        }

        if (badge.enabled === false) {
          this.options.logger.warn(`skipped "${filePath}": disabled.`)
          continue
        }

        const index = badge.index || BADGE_INDEX_DEFAULT
        const renderBadge = this.badge2RenderBadge(badge, level, index)

        const pushIndex = getPushIndex(index)
        items.splice(pushIndex, 0, renderBadge)
        this.options.logger.log(`added "${filePath}".`)
      }
    }

    return items
  }

  public renderBadgeItems2Readme(items: RenderItem[]): string {
    const readmeTpl = fs.readFileSync(this.options.tplPath, 'utf-8')
    const readme = DO_NOT_EDIT + ArtTemplate.render(readmeTpl, {
      renderItems: items,
      badgeLength: items.filter(item => item.type === 'badge').length,
      guideBadgeStyle: this.options.guideBadgeStyle || 'for-the-badge',
      tagBadgeStyle: this.options.tagBadgeStyle || 'flat',
    })
    return generateToc(readme, this.options.tplTocTitle)
  }

  public generateReadme(): string {
    return this.renderBadgeItems2Readme(
      this.loopReadBadgesDir(this.options.badgeDirPath),
    )
  }
}