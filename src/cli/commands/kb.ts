import { Command } from 'commander'
import chalk from 'chalk'
import path from 'path'
import fs from 'fs-extra'
import { Output } from '../utils/output'
import { handleError } from '../utils/errors'
import { KnowledgeBaseManager } from '../../core/KnowledgeBaseManager'
import { getSkillsSourcePath } from '../../utils/paths'

function getKB(): KnowledgeBaseManager {
  return new KnowledgeBaseManager(process.cwd())
}

function requireInit(kb: KnowledgeBaseManager): boolean {
  if (!kb.isInitialized()) {
    Output.error('Knowledge Base not initialized. Run: orka kb init')
    return false
  }
  return true
}

export function kbCommand(program: Command) {
  const kb = program
    .command('kb')
    .description('Project knowledge base — track decisions, meetings, questions, and more')

  // --- init ---
  kb.command('init')
    .description('Initialize Knowledge Base in current project')
    .option('--skip-skills', 'Do not install Claude Code skills')
    .action(async (opts) => {
      try {
        const manager = getKB()

        if (manager.isInitialized()) {
          Output.warn('Knowledge Base already initialized')
          return
        }

        await manager.initialize()
        Output.success('Knowledge Base initialized in .orka-kb/')

        if (!opts.skipSkills) {
          await installSkills()
        }
      } catch (error) {
        handleError(error)
      }
    })

  // --- add ---
  kb.command('add <type> <title>')
    .description('Add a new entity (decision, meeting, question, person, direction, repo, artifact, milestone, context)')
    .option('-s, --status <status>', 'Entity status', 'active')
    .option('-p, --property <kv...>', 'Properties as key=value pairs')
    .option('-t, --tag <tags...>', 'Tags')
    .option('-l, --link <links...>', 'Links as relation:target-id')
    .option('--json', 'Output as JSON')
    .action(async (type, title, opts) => {
      try {
        const manager = getKB()
        if (!requireInit(manager)) return

        const properties: Record<string, unknown> = {}
        if (opts.property) {
          for (const kv of opts.property) {
            const [key, ...rest] = kv.split('=')
            properties[key] = rest.join('=')
          }
        }

        const edges: Array<{ relation: string; target: string }> = []
        if (opts.link) {
          for (const link of opts.link) {
            const [relation, target] = link.split(':')
            if (relation && target) {
              edges.push({ relation, target })
            }
          }
        }

        const entity = await manager.addEntity(type, title, {
          status: opts.status,
          properties,
          tags: opts.tag || [],
          edges,
        })

        if (opts.json) {
          console.log(JSON.stringify(entity, null, 2))
        } else {
          Output.success(`Created ${chalk.bold(type)}: ${chalk.cyan(entity.title)} (${chalk.gray(entity.id)})`)
          if (edges.length > 0) {
            console.log(chalk.gray(`  Links: ${edges.map((e) => `${e.relation} → ${e.target}`).join(', ')}`))
          }
        }
      } catch (error) {
        handleError(error)
      }
    })

  // --- update ---
  kb.command('update <id>')
    .description('Update an entity')
    .option('-s, --status <status>', 'New status')
    .option('--title <title>', 'New title')
    .option('-p, --property <kv...>', 'Properties as key=value pairs')
    .option('-t, --tag <tags...>', 'Add tags')
    .option('--remove-tag <tags...>', 'Remove tags')
    .option('--json', 'Output as JSON')
    .action(async (id, opts) => {
      try {
        const manager = getKB()
        if (!requireInit(manager)) return

        const entity = await manager.updateEntity(id, {
          status: opts.status,
          title: opts.title,
          properties: opts.property ? parseProperties(opts.property) : undefined,
          addTags: opts.tag,
          removeTags: opts.removeTag,
        })

        if (opts.json) {
          console.log(JSON.stringify(entity, null, 2))
        } else {
          Output.success(`Updated: ${chalk.cyan(entity.title)} (${chalk.gray(entity.id)}) → status: ${entity.status}`)
        }
      } catch (error) {
        handleError(error)
      }
    })

  // --- link ---
  kb.command('link <source> <relation> <target>')
    .description('Create a relationship between entities')
    .action(async (source, relation, target) => {
      try {
        const manager = getKB()
        if (!requireInit(manager)) return

        await manager.addEdge(source, relation, target)
        Output.success(`Linked: ${chalk.cyan(source)} —[${chalk.yellow(relation)}]→ ${chalk.cyan(target)}`)
      } catch (error) {
        handleError(error)
      }
    })

  // --- show ---
  kb.command('show <id>')
    .description('Display an entity with its edges')
    .option('--json', 'Output as JSON')
    .action(async (id, opts) => {
      try {
        const manager = getKB()
        if (!requireInit(manager)) return

        const entity = await manager.getEntity(id)
        if (!entity) {
          Output.error(`Entity not found: ${id}`)
          return
        }

        if (opts.json) {
          console.log(JSON.stringify(entity, null, 2))
          return
        }

        console.log()
        console.log(chalk.bold.cyan(`  ${entity.title}`))
        console.log(chalk.gray(`  ${entity.id} | ${entity.type} | ${entity.status}`))
        console.log(chalk.gray(`  Created: ${entity.created.split('T')[0]} | Updated: ${entity.updated.split('T')[0]}`))

        if (entity.tags.length > 0) {
          console.log(`  Tags: ${entity.tags.map((t) => chalk.yellow(`#${t}`)).join(' ')}`)
        }

        if (Object.keys(entity.properties).length > 0) {
          console.log(chalk.bold('\n  Properties:'))
          for (const [key, value] of Object.entries(entity.properties)) {
            console.log(`    ${chalk.white(key)}: ${chalk.gray(String(value))}`)
          }
        }

        if (entity.edges.length > 0) {
          console.log(chalk.bold('\n  Relationships:'))
          for (const edge of entity.edges) {
            console.log(`    → ${chalk.yellow(edge.relation)} → ${chalk.cyan(edge.target)} ${chalk.gray(`(since ${edge.since.split('T')[0]})`)}`)
          }
        }

        if (entity.history.length > 0) {
          console.log(chalk.bold('\n  History:'))
          for (const h of entity.history.slice(-5)) {
            console.log(`    ${chalk.gray(h.ts.split('T')[0])} ${h.summary}`)
          }
        }

        console.log()
      } catch (error) {
        handleError(error)
      }
    })

  // --- list ---
  kb.command('list')
    .description('List entities')
    .option('--type <type>', 'Filter by type')
    .option('--status <status>', 'Filter by status')
    .option('--tag <tag>', 'Filter by tag')
    .option('--json', 'Output as JSON')
    .action(async (opts) => {
      try {
        const manager = getKB()
        if (!requireInit(manager)) return

        const entities = await manager.listEntities({
          type: opts.type,
          status: opts.status,
          tag: opts.tag,
        })

        if (opts.json) {
          console.log(JSON.stringify(entities, null, 2))
          return
        }

        if (entities.length === 0) {
          Output.info('No entities found')
          return
        }

        console.log(chalk.bold.cyan(`\n  Entities (${entities.length}):\n`))
        for (const e of entities) {
          const tags = e.tags.length > 0 ? chalk.yellow(` [${e.tags.join(', ')}]`) : ''
          const status = e.status !== 'active' ? chalk.gray(` (${e.status})`) : ''
          console.log(`  ${chalk.gray(e.id)} ${chalk.bold(e.title)}${status}${tags}`)
          console.log(`    ${chalk.gray(`${e.type} | updated ${e.updated.split('T')[0]} | ${e.edges.length} links`)}`)
        }
        console.log()
      } catch (error) {
        handleError(error)
      }
    })

  // --- history ---
  kb.command('history <id>')
    .description('Show event history for an entity')
    .action(async (id) => {
      try {
        const manager = getKB()
        if (!requireInit(manager)) return

        const events = await manager.getEntityHistory(id)

        if (events.length === 0) {
          Output.info(`No events found for: ${id}`)
          return
        }

        console.log(chalk.bold.cyan(`\n  History for ${id}:\n`))
        for (const evt of events) {
          const date = evt.ts.split('T')[0]
          const time = evt.ts.split('T')[1]?.slice(0, 5) || ''
          console.log(`  ${chalk.gray(`${date} ${time}`)} ${chalk.white(evt.type)} ${chalk.gray(`(${evt.actor})`)}`)
        }
        console.log()
      } catch (error) {
        handleError(error)
      }
    })

  // --- timeline ---
  kb.command('timeline')
    .description('Show event timeline')
    .option('--since <date>', 'Show events since date (YYYY-MM-DD)')
    .option('--limit <n>', 'Limit number of events', '30')
    .action(async (opts) => {
      try {
        const manager = getKB()
        if (!requireInit(manager)) return

        const events = await manager.getTimeline({
          since: opts.since,
          limit: parseInt(opts.limit, 10),
        })

        if (events.length === 0) {
          Output.info('No events found')
          return
        }

        console.log(chalk.bold.cyan(`\n  Timeline (${events.length} events):\n`))
        let currentDate = ''
        for (const evt of events) {
          const date = evt.ts.split('T')[0]
          if (date !== currentDate) {
            currentDate = date
            console.log(chalk.bold(`\n  ${date}`))
          }
          const time = evt.ts.split('T')[1]?.slice(0, 5) || ''
          const entity = evt.entityId ? chalk.cyan(` ${evt.entityId}`) : ''
          console.log(`    ${chalk.gray(time)} ${evt.type}${entity}`)
        }
        console.log()
      } catch (error) {
        handleError(error)
      }
    })

  // --- graph ---
  kb.command('graph')
    .description('Export knowledge graph')
    .option('--format <format>', 'Output format: dot or json', 'dot')
    .action(async (opts) => {
      try {
        const manager = getKB()
        if (!requireInit(manager)) return

        const output = await manager.exportGraph(opts.format)
        console.log(output)
      } catch (error) {
        handleError(error)
      }
    })

  // --- context ---
  kb.command('context')
    .description('Output AI-optimized project context')
    .action(async () => {
      try {
        const manager = getKB()
        if (!requireInit(manager)) return

        const context = await manager.generateContext()
        console.log(context)
      } catch (error) {
        handleError(error)
      }
    })

  // --- sync ---
  kb.command('sync')
    .description('Rebuild entities and views from event log')
    .action(async () => {
      try {
        const manager = getKB()
        if (!requireInit(manager)) return

        await manager.sync()
        Output.success('Knowledge Base synced — entities and views rebuilt from events')
      } catch (error) {
        handleError(error)
      }
    })

  // --- migrate ---
  kb.command('migrate')
    .description('Bootstrap KB from existing project (git, docs)')
    .action(async () => {
      try {
        const manager = getKB()

        if (!manager.isInitialized()) {
          await manager.initialize()
          Output.success('Knowledge Base initialized')
        }

        Output.info('Analyzing project...')
        const events = await manager.migrate()
        Output.success(`Migration complete — created ${events.length} entities from project analysis`)
      } catch (error) {
        handleError(error)
      }
    })

  // --- ingest ---
  kb.command('ingest <file>')
    .description('Parse a file and extract entities (basic structural parsing)')
    .action(async (file) => {
      try {
        const manager = getKB()
        if (!requireInit(manager)) return

        const fullPath = path.resolve(file)
        if (!await fs.pathExists(fullPath)) {
          Output.error(`File not found: ${file}`)
          return
        }

        // Create artifact entity referencing the file
        const entity = await manager.addEntity('artifact', path.basename(file), {
          properties: { filePath: fullPath, ingestedAt: new Date().toISOString() },
          tags: ['ingested'],
        })

        Output.success(`Ingested: ${chalk.cyan(path.basename(file))} → ${chalk.gray(entity.id)}`)
        Output.info('For AI-assisted parsing, use the /kb-ingest skill in Claude Code')
      } catch (error) {
        handleError(error)
      }
    })
}

// --- Helpers ---

function parseProperties(kvPairs: string[]): Record<string, unknown> {
  const props: Record<string, unknown> = {}
  for (const kv of kvPairs) {
    const [key, ...rest] = kv.split('=')
    props[key] = rest.join('=')
  }
  return props
}

async function installSkills(): Promise<void> {
  const projectPath = process.cwd()
  const skillsDir = path.join(projectPath, '.claude', 'skills')
  await fs.ensureDir(skillsDir)

  const skillsSource = getSkillsSourcePath()
  if (!skillsSource) {
    Output.warn('Skills source not found — skills not installed')
    return
  }

  const files = await fs.readdir(skillsSource)
  let installed = 0

  for (const file of files) {
    if (!file.endsWith('.md')) continue
    const dest = path.join(skillsDir, file)
    await fs.copy(path.join(skillsSource, file), dest)
    installed++
  }

  if (installed > 0) {
    Output.success(`Installed ${installed} Claude Code skills in .claude/skills/`)
  } else {
    Output.info('Claude Code skills already installed')
  }
}
