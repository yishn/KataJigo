#!/usr/bin/env node

const {dirname, join} = require('path')
const {Controller, Engine} = require('@sabaki/gtp')
const {version} = require('../package.json')

function parseAnalysis(line) {
  return line
    .split(/\s*info\s+/)
    .slice(1)
    .map(x => x.trim())
    .map(x => {
      let matchPV = x.match(/(pass|[A-Za-z]\d+)(\s+(pass|[A-Za-z]\d+))*$/)
      if (matchPV == null) return null

      let passIndex = matchPV[0].indexOf('pass')
      if (passIndex < 0) passIndex = Infinity

      return [
        x
          .slice(0, matchPV.index)
          .trim()
          .split(/\s+/)
          .slice(0, -1),
        matchPV[0]
          .slice(0, passIndex)
          .split(/\s+/)
          .filter(x => x.length >= 2)
      ]
    })
    .filter(x => x != null)
    .map(([tokens, pv]) => {
      let keys = tokens.filter((_, i) => i % 2 === 0)
      let values = tokens.filter((_, i) => i % 2 === 1)

      keys.push('pv')
      values.push(pv)

      return keys.reduce((acc, x, i) => ((acc[x] = values[i]), acc), {})
    })
    .filter(({move}) => move.match(/^[A-Za-z]\d+$/))
    .map(result => ({
      ...result,
      winrate: +result.winrate,
      scoreLead: +result.scoreLead
    }))
}

async function main() {
  let args = process.argv.slice(2)
  let gtpMode = args[0] === 'gtp'
  let katagoPath = join(dirname(process.execPath), 'katago')

  let controller = new Controller(katagoPath, args)
  let engine = new Engine('KataJigo', version)

  controller.on('started', () => {
    if (!gtpMode) {
      controller.process.stdout.on('data', chunk => {
        process.stdout.write(chunk)
      })
    }
  })

  controller.on('stopped', () => {
    process.exit()
  })

  controller.on('stderr', ({content}) => {
    process.stderr.write(content + '\n')
  })

  async function genmoveAnalyze(args, subscriber = () => {}) {
    let lastAnalysis = null
    let originalMove = null
    let foundMove = null
    let response = await controller.sendCommand(
      {
        name: 'kata-genmove_analyze',
        args
      },
      evt => {
        if (evt.line.startsWith('info ')) {
          lastAnalysis = parseAnalysis(evt.line)
        } else if (evt.line.startsWith('play ') && lastAnalysis != null) {
          originalMove = evt.line.slice('play '.length).trim()

          lastAnalysis = lastAnalysis.filter(
            // Ensure we're still winning
            variation => variation.winrate >= 0.5 && variation.scoreLead >= 0
          )

          let minScoreLead = Math.min(
            ...lastAnalysis.map(variation => variation.scoreLead)
          )

          lastAnalysis = lastAnalysis.filter(
            variation => variation.scoreLead === minScoreLead
          )

          let maxWinrate = Math.max(
            ...lastAnalysis.map(variation => variation.winrate)
          )

          lastAnalysis = lastAnalysis.filter(
            variation => variation.winrate === maxWinrate
          )

          if (lastAnalysis.length > 0) {
            let variation = lastAnalysis[0]

            for (let [key, value] of Object.entries(variation)) {
              console.error(
                `${key}: ${Array.isArray(value) ? value.join(' ') : value}`
              )
            }

            foundMove = variation.move
            evt.line = `play ${variation.move}`
          }
        }

        if (originalMove != null && foundMove != null) {
          evt.response.content = evt.response.content.replace(
            `play ${originalMove}`,
            `play ${foundMove}`
          )
        }

        subscriber(evt)
      }
    )

    if (!response.error && foundMove != null) {
      await controller.sendCommand({name: 'undo'})
      await controller.sendCommand({name: 'play', args: [args[0], foundMove]})
    }

    return response
  }

  engine.on('command-received', ({command}) => {
    if (
      ![
        'name',
        'version',
        'list_commands',
        'lz-genmove_analyze',
        'genmove'
      ].includes(command.name)
    ) {
      engine.command(command.name, async (command, out) => {
        let firstWrite = true
        let subscriber = ({response, end, line}) => {
          if (!response.error && !end) {
            if (!firstWrite) out.write('\n')
            out.write(firstWrite ? response.content : line)
            firstWrite = false
          }
        }

        let response =
          command.name === 'kata-genmove_analyze'
            ? await genmoveAnalyze(command.args, subscriber)
            : await controller.sendCommand(command, subscriber)

        if (response.error) out.err(response.content)
        out.end()
      })
    }
  })

  engine.on('abort-received', () => {
    controller.sendAbort()
  })

  engine.command('list_commands', async (command, out) => {
    let response = await controller.sendCommand(command)
    let commands = response.content
      .split('\n')
      .filter(x => x !== 'lz-genmove_analyze')

    out.send(commands.join('\n'))
  })

  engine.command('genmove', async (command, out) => {
    let response = await genmoveAnalyze(command.args.slice(0, 1), ({line}) => {
      if (line.startsWith('play ')) {
        let move = line.slice('play '.length).trim()
        out.send(move)
      }
    })

    if (response.error) out.err(response.content)
  })

  controller.start()
  if (gtpMode) engine.start()
}

main().catch(console.error)
