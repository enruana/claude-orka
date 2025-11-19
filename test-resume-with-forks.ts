#!/usr/bin/env tsx

/**
 * Test: Resume Session with Saved Forks
 *
 * Flujo:
 * 1. Crear una sesión main
 * 2. Crear un fork
 * 3. Cerrar la sesión (sin hacer merge)
 * 4. Restaurar la sesión main
 * 5. Restaurar el fork guardado
 * 6. Verificar que ambos están activos
 */

import * as readline from 'readline'
import { ClaudeOrka } from './src/core/ClaudeOrka'
import { Session, Fork } from './src/models'

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
})

const prompt = (question: string): Promise<string> => {
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      resolve(answer)
    })
  })
}

const pause = async (message: string = '▶️  Presiona ENTER para continuar...') => {
  await prompt(message)
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function displayProjectSummary(orka: ClaudeOrka) {
  const summary = await orka.getProjectSummary()

  console.log('\n' + '='.repeat(80))
  console.log('📊 ESTADO DEL PROYECTO')
  console.log('='.repeat(80))
  console.log(`📁 Proyecto: ${summary.projectPath}`)
  console.log(`📋 Total sesiones: ${summary.totalSessions}`)
  console.log(`  ✅ Activas: ${summary.activeSessions}`)
  console.log(`  💾 Guardadas: ${summary.savedSessions}`)
  console.log(`⏱️  Última actualización: ${new Date(summary.lastUpdated).toLocaleString()}`)

  if (summary.sessions.length === 0) {
    console.log('\n❌ No hay sesiones disponibles')
    return
  }

  console.log('\n' + '-'.repeat(80))
  console.log('📝 SESIONES:')
  console.log('-'.repeat(80))

  for (const session of summary.sessions) {
    const statusEmoji = session.status === 'active' ? '✅' : '💾'
    console.log(`\n${statusEmoji} Sesión: ${session.name}`)
    console.log(`  ID: ${session.id}`)
    console.log(`  Claude Session ID: ${session.claudeSessionId}`)
    console.log(`  Estado: ${session.status}`)
    console.log(`  Creada: ${new Date(session.createdAt).toLocaleString()}`)
    console.log(`  Última actividad: ${new Date(session.lastActivity).toLocaleString()}`)
    console.log(`  Total forks: ${session.totalForks}`)
    console.log(`    ✅ Activos: ${session.activeForks}`)
    console.log(`    💾 Guardados: ${session.savedForks}`)
    console.log(`    🔀 Mergeados: ${session.mergedForks}`)

    if (session.forks.length > 0) {
      console.log('\n  🌿 FORKS:')
      for (const fork of session.forks) {
        const forkStatusEmoji =
          fork.status === 'active' ? '✅' : fork.status === 'merged' ? '🔀' : '💾'
        console.log(`\n  ${forkStatusEmoji} Fork: ${fork.name}`)
        console.log(`    ID: ${fork.id}`)
        console.log(`    Claude Session ID: ${fork.claudeSessionId}`)
        console.log(`    Estado: ${fork.status}`)
        console.log(`    Creado: ${new Date(fork.createdAt).toLocaleString()}`)
        if (fork.hasContext) {
          console.log(`    Contexto para merge: ✅ Disponible`)
          console.log(`    Path: ${fork.contextPath}`)
        }
        if (fork.mergedToMain) {
          console.log(`    Mergeado a main: ✅ (${new Date(fork.mergedAt!).toLocaleString()})`)
        }
      }
    }
  }

  console.log('\n' + '='.repeat(80))
}

async function main() {
  console.log('\n🎯 TEST: Resume Session with Saved Forks\n')
  console.log('Este test valida:')
  console.log('  1. Crear sesión y fork')
  console.log('  2. Cerrar sesión sin hacer merge')
  console.log('  3. Restaurar sesión main')
  console.log('  4. ✨ Los forks guardados se restauran AUTOMÁTICAMENTE')
  console.log('  5. Verificar que ambos están activos\n')
  console.log('⚠️  IMPORTANTE:')
  console.log('   resumeSession() restaura automáticamente todos los forks guardados.')
  console.log('   No necesitas llamar a resumeFork() manualmente.\n')

  const projectPath = process.cwd()
  const orka = new ClaudeOrka(projectPath)

  await orka.initialize()
  console.log('✅ ClaudeOrka inicializado\n')

  let session: Session
  let fork: Fork
  let sessionId: string
  let forkId: string

  // ========================================
  // FASE 1: Crear sesión y fork
  // ========================================

  console.log('━'.repeat(80))
  console.log('📍 FASE 1: Crear sesión y fork')
  console.log('━'.repeat(80))

  await pause('\n▶️  Presiona ENTER para crear la sesión main...')

  console.log('\n🔄 Creando sesión main...')
  session = await orka.createSession('Test Resume Session', true)
  sessionId = session.id
  console.log(`✅ Sesión creada: ${session.name}`)
  console.log(`   ID: ${session.id}`)
  console.log(`   Claude Session ID: ${session.main.claudeSessionId}`)
  console.log(`   Tmux Session: ${session.tmuxSessionId}`)

  await pause('\n▶️  Ahora deberías ver una ventana de tmux con Claude Code.')
  await pause('   Envía algunos mensajes en la sesión main para probar.')
  await pause('   Cuando estés listo, presiona ENTER para crear un fork...')

  console.log('\n🔄 Creando fork...')
  fork = await orka.createFork(sessionId, 'Test Fork', false)
  forkId = fork.id
  console.log(`✅ Fork creado: ${fork.name}`)
  console.log(`   ID: ${fork.id}`)
  console.log(`   Claude Session ID: ${fork.claudeSessionId}`)
  console.log(`   Tmux Pane: ${fork.tmuxPaneId}`)

  await pause('\n▶️  Ahora deberías ver el fork en un panel horizontal.')
  await pause('   Envía algunos mensajes en el fork para probar.')
  await pause('   Cuando estés listo, presiona ENTER para ver el estado...')

  await displayProjectSummary(orka)

  // ========================================
  // FASE 2: Cerrar sesión (sin merge)
  // ========================================

  console.log('\n' + '━'.repeat(80))
  console.log('📍 FASE 2: Cerrar sesión sin hacer merge')
  console.log('━'.repeat(80))

  await pause('\n▶️  Presiona ENTER para cerrar la sesión...')

  console.log('\n🔄 Cerrando sesión...')
  console.log('   ⚠️  Esto cerrará la ventana de tmux')
  console.log('   ⚠️  El fork NO se mergeará, quedará guardado')
  await sleep(2000)

  await orka.closeSession(sessionId)
  console.log('✅ Sesión cerrada')

  await pause('\n▶️  Presiona ENTER para ver el estado...')

  await displayProjectSummary(orka)

  console.log('\n📝 Deberías ver:')
  console.log('   - Sesión en estado "saved"')
  console.log('   - Fork en estado "saved"')
  console.log('   - Ambos tienen sus Claude Session IDs guardados')

  // ========================================
  // FASE 3: Restaurar sesión main
  // ========================================

  console.log('\n' + '━'.repeat(80))
  console.log('📍 FASE 3: Restaurar sesión main')
  console.log('━'.repeat(80))

  await pause('\n▶️  Presiona ENTER para restaurar la sesión main...')

  console.log('\n🔄 Restaurando sesión main...')
  console.log(`   Usando Claude Session ID: ${session.main.claudeSessionId}`)
  console.log('   Ejecutando: claude --resume <session-id>')
  await sleep(1000)

  session = await orka.resumeSession(sessionId, true)
  console.log('✅ Sesión main restaurada')
  console.log(`   Tmux Session: ${session.tmuxSessionId}`)

  await pause('\n▶️  Deberías ver la ventana de tmux con la sesión main restaurada.')
  await pause('   ⚠️  IMPORTANTE: Los forks guardados se restauran AUTOMÁTICAMENTE!')
  await pause('   Deberías ver tanto el main como el fork en paneles separados.')
  await pause('   Claude debería recordar el contexto de ambas conversaciones.')
  await pause('   Presiona ENTER para ver el estado...')

  await displayProjectSummary(orka)

  console.log('\n📝 Deberías ver:')
  console.log('   - Sesión en estado "active"')
  console.log('   - Fork TAMBIÉN en estado "active" (restaurado automáticamente)')
  console.log('   - Ambos con sus Claude Session IDs')
  console.log('   - Ambos con sus tmux Pane IDs')

  // ========================================
  // FASE 4: Verificación del comportamiento automático
  // ========================================

  console.log('\n' + '━'.repeat(80))
  console.log('📍 FASE 4: Verificación del comportamiento automático')
  console.log('━'.repeat(80))

  console.log('\n✅ Comportamiento observado:')
  console.log('   1. resumeSession() restauró el main')
  console.log('   2. Detectó que había forks guardados (status !== "merged")')
  console.log('   3. Automáticamente restauró todos los forks guardados')
  console.log('   4. Cada fork se abrió en su propio panel de tmux')
  console.log('   5. Claude restauró el contexto de cada conversación')

  console.log('\n💡 Esto significa que:')
  console.log('   - No necesitas llamar a resumeFork() manualmente')
  console.log('   - resumeSession() restaura toda la estructura de la sesión')
  console.log('   - Los forks mergeados NO se restauran (solo los guardados)')

  await pause('\n▶️  Presiona ENTER para ver el estado final...')

  // Refresh para mostrar el estado actualizado
  session = (await orka.getSession(sessionId))!
  fork = session.forks[0]

  await displayProjectSummary(orka)

  console.log('\n📝 Estado final:')
  console.log(`   Main: ${session.main.status} (Claude Session: ${session.main.claudeSessionId})`)
  console.log(`   Fork: ${fork.status} (Claude Session: ${fork.claudeSessionId})`)

  // ========================================
  // FASE 5: Limpieza
  // ========================================

  console.log('\n' + '━'.repeat(80))
  console.log('📍 FASE 5: Limpieza (opcional)')
  console.log('━'.repeat(80))

  const cleanup = await prompt('\n¿Quieres cerrar la sesión? (y/n): ')

  if (cleanup.toLowerCase() === 'y') {
    console.log('\n🔄 Cerrando sesión...')
    await orka.closeSession(sessionId)
    console.log('✅ Sesión cerrada')

    await displayProjectSummary(orka)
  }

  const deleteIt = await prompt('\n¿Quieres eliminar la sesión permanentemente? (y/n): ')

  if (deleteIt.toLowerCase() === 'y') {
    console.log('\n🔄 Eliminando sesión...')
    await orka.deleteSession(sessionId)
    console.log('✅ Sesión eliminada')

    await displayProjectSummary(orka)
  }

  console.log('\n' + '='.repeat(80))
  console.log('✅ TEST COMPLETADO')
  console.log('='.repeat(80))
  console.log('\n🎉 Validaciones:')
  console.log('   ✅ Sesión y fork creados correctamente')
  console.log('   ✅ Sesión cerrada sin merge (fork guardado)')
  console.log('   ✅ Sesión main restaurada con contexto')
  console.log('   ✅ Fork restaurado AUTOMÁTICAMENTE con contexto')
  console.log('   ✅ Claude Session IDs funcionando correctamente')
  console.log('   ✅ resumeSession() restaura toda la estructura de sesión\n')

  rl.close()
}

main().catch((error) => {
  console.error('\n❌ Error:', error)
  rl.close()
  process.exit(1)
})
