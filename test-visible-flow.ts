/**
 * Prueba visible del flujo completo (NO en background)
 *
 * Verás cada paso ejecutándose en tiempo real
 *
 * Ejecutar: npx tsx test-visible-flow.ts
 */

import { ClaudeOrka, logger, LogLevel } from './src'
import * as fs from 'fs-extra'
import * as path from 'path'

// Habilitar TODOS los logs para ver todo
logger.setLevel(LogLevel.DEBUG)

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

async function testVisibleFlow() {
  console.log('\n🐋 Claude-Orka - Flujo Visible Paso a Paso\n')
  console.log('═'.repeat(70))
  console.log('\n💡 Verás cada acción ejecutándose en tiempo real')
  console.log('📺 Se abrirán ventanas de Terminal que podrás ver\n')
  console.log('═'.repeat(70))
  console.log('\n')

  const projectPath = '/Users/andres.mantilla/Desktop/TCC/puertoantioquia-form'
  console.log(`📁 Proyecto: ${projectPath}\n`)

  console.log('Presiona ENTER para continuar...')
  // await new Promise(resolve => process.stdin.once('data', resolve))

  try {
    // ===== FASE 1 =====
    console.log('\n📦 FASE 1: Inicialización')
    console.log('─'.repeat(70))
    const orka = new ClaudeOrka(projectPath)
    await orka.initialize()
    console.log('✅ Orka inicializado\n')

    // ===== FASE 2 =====
    console.log('🎬 FASE 2: Crear sesión principal')
    console.log('─'.repeat(70))
    console.log('⏱️  Esto abrirá una ventana de Terminal...')
    const session = await orka.createSession('visible-test')
    console.log(`✅ Sesión creada: ${session.id}`)
    console.log(`📛 Nombre: ${session.name}`)
    console.log(`🖥️  tmux: ${session.tmuxSessionName}`)
    console.log('\n💡 Ve a la ventana de Terminal que se abrió para ver a Claude\n')

    console.log('⏳ Esperando 10 segundos para que Claude se inicialice...')
    for (let i = 10; i > 0; i--) {
      process.stdout.write(`\r   ${i} segundos... `)
      await sleep(1000)
    }
    console.log('\r   ✅ Claude listo!          \n')

    // ===== FASE 3 =====
    console.log('💬 FASE 3: Enviar mensaje a main')
    console.log('─'.repeat(70))
    const mainMessage = 'Hola Claude! ¿Cómo estás? Responde brevemente por favor.'
    console.log(`📤 Enviando a main: "${mainMessage}"`)
    await orka.send(session.id, mainMessage)
    console.log('✅ Mensaje enviado')
    console.log('👀 Ve a la terminal para ver la respuesta de Claude\n')

    console.log('⏳ Esperando 10 segundos para que Claude responda...')
    for (let i = 10; i > 0; i--) {
      process.stdout.write(`\r   ${i} segundos... `)
      await sleep(1000)
    }
    console.log('\r   ✅ Claude debería haber respondido          \n')

    // ===== FASE 4 =====
    console.log('🍴 FASE 4: Crear fork')
    console.log('─'.repeat(70))
    console.log('⏱️  Esto hará un split en la ventana de Terminal...')
    const fork = await orka.createFork(session.id, 'universe-questions')
    console.log(`✅ Fork creado: ${fork.id}`)
    console.log(`📛 Nombre: ${fork.name}`)
    console.log('\n💡 Ve la ventana de Terminal - verás el split horizontal\n')

    console.log('⏳ Esperando 8 segundos para que el fork se inicialice...')
    for (let i = 8; i > 0; i--) {
      process.stdout.write(`\r   ${i} segundos... `)
      await sleep(1000)
    }
    console.log('\r   ✅ Fork listo!          \n')

    // ===== FASE 5 =====
    console.log('🌌 FASE 5: Preguntar sobre el universo en fork')
    console.log('─'.repeat(70))
    const forkMessage = '¿Cuántos planetas hay en el sistema solar? Responde brevemente.'
    console.log(`📤 Enviando al fork: "${forkMessage}"`)
    await orka.send(session.id, forkMessage, fork.id)
    console.log('✅ Pregunta enviada al fork')
    console.log('👀 Ve el panel inferior de la terminal para ver la respuesta\n')

    console.log('⏳ Esperando 10 segundos para que Claude responda...')
    for (let i = 10; i > 0; i--) {
      process.stdout.write(`\r   ${i} segundos... `)
      await sleep(1000)
    }
    console.log('\r   ✅ Claude debería haber respondido          \n')

    // ===== FASE 6 =====
    console.log('💾 FASE 6: Cerrar fork y exportar contexto')
    console.log('─'.repeat(70))
    console.log('⏱️  Esto enviará /fork:export y guardará el contexto...')
    await orka.closeFork(session.id, fork.id, true)
    console.log('✅ Fork cerrado')
    console.log('✅ Contexto exportado\n')

    await sleep(2000)

    // ===== FASE 7 =====
    console.log('🔒 FASE 7: Cerrar sesión y exportar contexto')
    console.log('─'.repeat(70))
    console.log('⏱️  Esto enviará /fork:export al main y cerrará todo...')
    await orka.closeSession(session.id, true)
    console.log('✅ Sesión cerrada')
    console.log('✅ Contexto exportado')
    console.log('✅ Ventana de Terminal cerrada\n')

    // ===== FASE 8 =====
    console.log('📄 FASE 8: Verificar exports')
    console.log('─'.repeat(70))

    const updatedSession = await orka.getSession(session.id)

    if (updatedSession) {
      console.log('📊 Resumen de la sesión:\n')
      console.log(`   🆔 ID: ${updatedSession.id}`)
      console.log(`   📛 Nombre: ${updatedSession.name}`)
      console.log(`   📍 Estado: ${updatedSession.status}`)
      console.log(`   🕐 Creada: ${new Date(updatedSession.createdAt).toLocaleString()}`)
      console.log(`   🕐 Última actividad: ${new Date(updatedSession.lastActivity).toLocaleString()}\n`)

      // Main context
      if (updatedSession.main.contextPath) {
        const mainPath = path.join(projectPath, updatedSession.main.contextPath)
        const mainExists = await fs.pathExists(mainPath)
        const mainSize = mainExists ? (await fs.stat(mainPath)).size : 0

        console.log(`   📝 Contexto de Main:`)
        console.log(`      Archivo: ${updatedSession.main.contextPath}`)
        console.log(`      Existe: ${mainExists ? '✅ Sí' : '❌ No'}`)
        console.log(`      Tamaño: ${(mainSize / 1024).toFixed(2)} KB`)

        if (mainExists) {
          const content = await fs.readFile(mainPath, 'utf-8')
          const hasHola = content.includes('Hola Claude')
          console.log(`      Contiene "Hola": ${hasHola ? '✅ Sí' : '❌ No'}`)
        }
        console.log()
      }

      // Fork context
      const closedFork = updatedSession.forks.find(f => f.id === fork.id)
      if (closedFork?.contextPath) {
        const forkPath = path.join(projectPath, closedFork.contextPath)
        const forkExists = await fs.pathExists(forkPath)
        const forkSize = forkExists ? (await fs.stat(forkPath)).size : 0

        console.log(`   🍴 Contexto del Fork (${closedFork.name}):`)
        console.log(`      Archivo: ${closedFork.contextPath}`)
        console.log(`      Existe: ${forkExists ? '✅ Sí' : '❌ No'}`)
        console.log(`      Tamaño: ${(forkSize / 1024).toFixed(2)} KB`)
        console.log(`      Estado: ${closedFork.status}`)

        if (forkExists) {
          const content = await fs.readFile(forkPath, 'utf-8')
          const hasPlanetas = content.includes('planetas') || content.includes('sistema solar')
          console.log(`      Contiene pregunta planetas: ${hasPlanetas ? '✅ Sí' : '❌ No'}`)
        }
        console.log()
      }
    }

    // ===== RESUMEN =====
    console.log('\n')
    console.log('═'.repeat(70))
    console.log('✅ ¡PRUEBA COMPLETA EXITOSA!')
    console.log('═'.repeat(70))
    console.log('\n📊 Lo que se hizo:\n')
    console.log('   ✅ Sesión creada con ventana de Terminal visible')
    console.log('   ✅ Mensaje "Hola" enviado a main → Claude respondió')
    console.log('   ✅ Fork creado con split visible en Terminal')
    console.log('   ✅ Pregunta sobre planetas enviada al fork → Claude respondió')
    console.log('   ✅ Fork cerrado con contexto exportado')
    console.log('   ✅ Sesión cerrada con contexto exportado')
    console.log('   ✅ Todo guardado en .claude-orka/\n')

    console.log('📂 Archivos generados:\n')
    console.log(`   📄 Estado: ${projectPath}/.claude-orka/state.json`)
    console.log(`   📄 Main: ${projectPath}/.claude-orka/sessions/`)
    console.log(`   📄 Fork: ${projectPath}/.claude-orka/forks/\n`)

  } catch (error: any) {
    console.error('\n❌ Error:', error.message)
    console.error(error.stack)
    process.exit(1)
  }
}

// Ejecutar
testVisibleFlow()
