import fs from 'fs/promises'
import path from 'path'
import { components } from 'vuetify/dist/vuetify.js'
import Piscina from 'piscina'
import { stringifyProps } from './utils'
import * as os from 'os'
import mkdirp from 'mkdirp'
import inspector from 'inspector'
import yargs from 'yargs'
import { kebabCase } from './helpers/text'
import { file } from '@babel/types'

type TranslationData = {
  [type in 'props' | 'events' | 'slots' | 'exposed']?: {
    [name in string]?: string
  }
}

const yar = yargs(process.argv.slice(2))
  .option('components', {
    type: 'array',
  })

const run = async () => {
  const argv = await yar.argv
  const locales = ['en']

  // Components
  const pool = new Piscina({
    filename: './src/worker.js',
    niceIncrement: 10,
    maxThreads: inspector.url() ? 1 : Math.max(1, Math.floor(Math.min(os.cpus().length / 2, os.freemem() / (1.1 * 1024 ** 3)))),
  })

  const template = await fs.readFile('./src/template.d.ts', 'utf-8')

  await mkdirp('./src/tmp')
  for (const component in components) {
    await fs.writeFile(`./src/tmp/${component}.d.ts`, template.replaceAll('__component__', component))
  }

  const outPath = path.resolve(__dirname, '../../docs/src/api/data/')

  const componentData = await Promise.all(
    Object.entries(components).map(([componentName, componentInstance]) => {
      if (argv.components && !argv.components.includes(componentName)) return null

      return pool.run(
        JSON.stringify({
          componentName,
          componentProps: stringifyProps(componentInstance.props),
          locales,
          outPath,
        })
      )
    }).filter(Boolean)
  )

  const translations: { [filename in string]?: TranslationData } = {}

  async function readData (filename: string): Promise<TranslationData> {
    if (!(filename in translations)) {
      try {
        const data = JSON.parse(await fs.readFile(filename, 'utf-8'))

        for (const type of ['props', 'events', 'slots', 'exposed']) {
          for (const item in data[type] ?? {}) {
            if (data[type][item].startsWith('MISSING DESCRIPTION')) {
              delete data[type][item]
            }
          }
        }

        translations[filename] = data
      } catch (e) {
        translations[filename] = {}
      }
    }

    return translations[filename]
  }

  const componentsWithNoPropsSource = new Set<string>()

  for (const index in componentData) {
    const component = componentData[index]

    for (const type of ['props', 'events', 'slots', 'exposed']) {
      for (const name in component[type]) {
        if (type === 'props' && !component[type][name].source) componentsWithNoPropsSource.add(componentData[index].componentName)

        const filename = type === 'props'
          ? kebabCase(component[type][name].source ?? componentData[index].componentName)
          : component.kebabName

        for (const locale of locales) {
          const sourceData = await readData(`./src/locale/${locale}/${filename}.json`)
          const githubUrl = `https://github.com/vuetifyjs/vuetify/tree/next/packages/api-generator/src/locale/${locale}/${filename}.json`

          sourceData[type] ??= {}
          sourceData[type][name] ??= `MISSING DESCRIPTION ([edit in github](${githubUrl}))`
        }
      }
    }
  }

  console.log([...componentsWithNoPropsSource])

  for (const filename in translations) {
    try {
      await fs.writeFile(filename, JSON.stringify(translations[filename], null, 2) + '\n')
    } catch (e: unknown) {
      console.error(filename, e)
    }
  }
}

run()
