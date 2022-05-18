import fs from 'fs'
import StackTracey from 'stacktracey'
import {
  SourceMapConsumer,
  BasicSourceMapConsumer,
  IndexedSourceMapConsumer,
  Position,
} from 'source-map'
import axios from 'axios'

const nixSlashes = (x: string) => x.replace(/\\/g, '/')
const sourcemapCatch: Record<string, string | Promise<string>> = {}

type StacktraceyItems = StackTracey.Entry & {
  errMsg?: string
}
type Stacktracey = {
  items: StacktraceyItems[]
  asTable?: StackTracey['asTable']
}
interface StacktraceyPreset {
  /**
   * 解析错误栈信息
   * @param filename
   */
  parseStacktrace(stacktrace: string): Stacktracey
  /**
   * 根据错误信息重新赋值为错误栈信息
   * @param filename
   */
  asTableStacktrace(opts?: {
    maxColumnWidths?: StackTracey.MaxColumnWidths
    stacktrace: string
  }): string
  /**
   * 根据编译后的文件名地址
   * @param file
   * 根据编译后的文件名
   * @param filename
   */
  parseSourceMapUrl(file: string, fileName: string): string
}

interface StacktraceyOptions {
  preset: StacktraceyPreset
}

export function stacktracey(
  stacktrace: string,
  opts: StacktraceyOptions
): Promise<string> {
  const parseStack: Array<Promise<any>> = []

  const stack = opts.preset.parseStacktrace(stacktrace)

  stack.items.forEach((item, index) => {
    const fn = () => {
      const { line = 0, column = 0, file, fileName } = item
      let sourceMapUrl
      try {
        sourceMapUrl = opts.preset.parseSourceMapUrl(file, fileName)
        if (sourceMapUrl) {
          return Promise.resolve(getSourceMapContent(sourceMapUrl)).then(
            (content) => {
              if (content)
                return SourceMapConsumer.with(content, null, (consumer) => {
                  const sourceMapContent = parseSourceMapContent(consumer, {
                    line,
                    column,
                  })

                  if (sourceMapContent) {
                    const {
                      source,
                      sourcePath,
                      sourceLine,
                      sourceColumn,
                      fileName = '',
                    } = sourceMapContent

                    stack.items[index] = Object.assign({}, item, {
                      file: source,
                      line: sourceLine,
                      column: sourceColumn,
                      fileShort: sourcePath,
                      fileRelative: sourcePath,
                      fileName,
                    })
                  }
                })
            }
          )
        }
        return Promise.resolve()
      } catch (error) {
        return Promise.resolve()
      }
    }
    parseStack.push(fn())
  })

  return new Promise((resolve, reject) => {
    Promise.all(parseStack)
      .then(() => {
        const parseError = opts.preset.asTableStacktrace({
          maxColumnWidths: {
            callee: 999,
            file: 999,
            sourceLine: 999,
          },
          stacktrace,
        })
        resolve(parseError)
      })
      .catch(() => {
        resolve(stacktrace)
      })
  })
}

function getSourceMapContent(sourcemapUrl: string) {
  try {
    return (
      sourcemapCatch[sourcemapUrl] ||
      (sourcemapCatch[sourcemapUrl] = new Promise((resolve, reject) => {
        try {
          if (/^[a-z]+:/i.test(sourcemapUrl)) {
            axios
              .get(sourcemapUrl)
              .then((res) => {
                console.log('sourcemapUrl :>> ', sourcemapUrl)
                sourcemapCatch[sourcemapUrl] = res.data
                resolve(sourcemapCatch[sourcemapUrl])
              })
              .catch((_) => {
                resolve('')
              })
          } else {
            sourcemapCatch[sourcemapUrl] = fs.readFileSync(
              sourcemapUrl,
              'utf-8'
            )
            resolve(sourcemapCatch[sourcemapUrl])
          }
        } catch (error) {
          resolve('')
        }
      }))
    )
  } catch (error) {
    return ''
  }
}

type SourceMapContent =
  | undefined
  | {
      source: string
      sourcePath: string
      sourceLine: number
      sourceColumn: number
      fileName: string | undefined
    }
function parseSourceMapContent(
  consumer: BasicSourceMapConsumer | IndexedSourceMapConsumer,
  obj: Position
): SourceMapContent {
  // source -> 'uni-app:///node_modules/@sentry/browser/esm/helpers.js'
  const {
    source,
    line: sourceLine,
    column: sourceColumn,
  } = consumer.originalPositionFor(obj)
  if (source) {
    const sourcePathSplit = source.split('/')
    const sourcePath = sourcePathSplit.slice(3).join('/')
    const fileName = sourcePathSplit.pop()

    return {
      source,
      sourcePath,
      sourceLine: sourceLine === null ? 0 : sourceLine,
      sourceColumn: sourceColumn === null ? 0 : sourceColumn,
      fileName,
    }
  }
}

interface UniStracktraceyPresetOptions {
  base: string
  appId: string
  platform: string
  version: string
}
export function uniStracktraceyPreset(
  opts: UniStracktraceyPresetOptions
): StacktraceyPreset {
  const { base, platform, version } = opts

  let stack: Stacktracey

  return {
    parseSourceMapUrl(file, fileName) {
      if (!platform || !version) return ''
      // 根据 base,platform,version,filename 组合 sourceMapUrl
      return `${base}/${version}/.sourcemap/${platform}/${
        file.split('.')[0]
      }.js.map`
    },
    parseStacktrace(stacktrace) {
      return (stack = new StackTracey(stacktrace))
    },
    asTableStacktrace({ maxColumnWidths, stacktrace } = { stacktrace: '' }) {
      const errorName = stacktrace.split('\n')[0]
      return errorName.indexOf('at') === -1
        ? `${errorName}\n`
        : '' + (stack.asTable ? stack.asTable({ maxColumnWidths }) : '')
    },
  }
}

interface UtsStracktraceyPreset {
  /**
   * source 根目录（如：/wgtRoot/__UNI__E070870/nativeplugins/DCloud-UTSPlugin/android/src/）
   */
  sourceRoot: string
  /**
   * sourceMap 根目录
   */
  base: string
}
export function utsStracktraceyPreset(
  opts: UtsStracktraceyPreset
): StacktraceyPreset {
  let stack: Stacktracey
  return {
    parseSourceMapUrl(file, fileName) {
      // 根据 base,filename 组合 sourceMapUrl
      return `${opts.base}/${fileName}.map`
    },
    parseStacktrace(str) {
      const lines = (str || '').split('\n')

      const entries = lines
        .map((line) => {
          line = line.trim()

          let callee,
            fileLineColumn = [],
            planA,
            planB

          if ((planA = line.match(/e: \[(.+)\](.+): (.+)/))) {
            callee = planA[1]
            fileLineColumn = (
              planA[2].match(/(.+):.*\((\d+).+?(\d+)\)/) || []
            ).slice(1)
          } else {
            return undefined
          }

          const fileName = fileLineColumn[0]
            ? (planB = fileLineColumn[0].match(/(\/.*)*\/(.+)/) || [])[2] || ''
            : ''

          return {
            beforeParse: line,
            callee: callee || '',
            index: false,
            native: false,
            file: nixSlashes(fileLineColumn[0] || ''),
            line: parseInt(fileLineColumn[1] || '', 10) || undefined,
            column: parseInt(fileLineColumn[2] || '', 10) || undefined,
            fileName,
            fileShort: planB ? planB[1] : '',
            errMsg: planA[3] || '',
            calleeShort: '',
            fileRelative: '',
            thirdParty: false,
          }
        })
        .filter((x) => x !== undefined)

      return (stack = {
        items: entries as StackTracey.Entry[],
      })
    },
    asTableStacktrace({ stacktrace } = { stacktrace: '' }) {
      const stacktraceSplit = stacktrace.split('\n')
      const errorName = stacktraceSplit[0]
      const errorMsg = stacktraceSplit.pop()
      return (
        (errorName.indexOf('e:') === -1 ? `${errorName}\n` : '') +
        (stack.items
          .map(
            (item) =>
              `e: [${item.callee}]${item.fileShort}/${item.fileName}: (${item.line}, ${item.column}): ${item.errMsg}`
          )
          .join('\n') +
          (errorMsg ? `\n\n${errorMsg}` : ''))
      )
    },
  }
}
