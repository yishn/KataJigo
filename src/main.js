#!/usr/bin/env node

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
  let args = process.argv.slice(3)
  let controller = new Controller(process.argv[2], args)
  let engine = new Engine('KataJigo', version)

  controller.on('started', () => {
    if (args[0] !== 'gtp') {
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

          let minScoreLead = Math.min(
            ...lastAnalysis
              .filter(variation => variation.scoreLead >= 0)
              .map(variation => variation.scoreLead)
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

            console.error(`scoreLead: ${variation.scoreLead}`)
            console.error(`winrate: ${variation.winrate}`)

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
        'kata-genmove_analyze',
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
          command.name.match(/^\w+-genmove_analysis$/) != null
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
      .filter(x => x.match(/^(\w+-)?genmove_analyze$/) == null)

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
  engine.start()
}

main().catch(console.error)
