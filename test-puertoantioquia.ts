/**
 * Prueba de Claude-Orka en proyecto puertoantioquia-form
 *
 * Ejecutar: npx tsx test-puertoantioquia.ts
 */

import { ClaudeOrka, logger, LogLevel } from './src'

// Habilitar logs
logger.setLevel(LogLevel.INFO)

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

async function testPuertoAntioquia() {
  console.log('🐋 Claude-Orka - Prueba en puertoantioquia-form\n')

  const projectPath = '/Users/andres.mantilla/Desktop/TCC/puertoantioquia-form'

  console.log(`📁 Proyecto: ${projectPath}\n`)

  try {
    // Crear instancia de Orka
    const orka = new ClaudeOrka(projectPath)
    await orka.initialize()
    console.log('✅ Orka inicializado\n')

    // Crear sesión - se abrirá Terminal con claude --continue
    console.log('1️⃣  Creando sesión principal...')
    console.log('   📺 Se abrirá una ventana de Terminal con Claude Code')
    console.log('   ⚡ Usando "claude --continue" para mantener contexto\n')

    const session = await orka.createSession('puertoantioquia-dev')

    console.log(`   ✅ Sesión creada: ${session.id}`)
    console.log(`   📛 Nombre: ${session.name}`)
    console.log(`   🖥️  tmux: ${session.tmuxSessionName}\n`)

    // Esperar para que Claude se inicialice
    console.log('⏳ Esperando 10 segundos para que Claude se inicialice...\n')
    await sleep(10000)

    console.log('✅ Sesión lista para usar!\n')
    console.log('📝 Ahora puedes:')
    console.log('   1. Ir a la ventana de Terminal que se abrió')
    console.log('   2. Interactuar con Claude normalmente')
    console.log('   3. Crear forks cuando quieras explorar alternativas')
    console.log('   4. Claude ya tiene el contexto del proyecto (--continue)\n')

    console.log('🍴 ¿Quieres crear un fork para probar?')
    console.log('   Descomenta la sección de abajo y ejecuta de nuevo\n')

    // Para crear fork, descomenta esto:
    /*
    console.log('2️⃣  Creando fork...')
    const fork = await orka.createFork(session.id, 'testing-feature')
    console.log(`   ✅ Fork creado: ${fork.id}`)
    console.log(`   📺 Verás un split en la ventana de Terminal\n`)
    */

    console.log('💡 Para cerrar la sesión cuando termines:')
    console.log(`   await orka.closeSession('${session.id}')`)
    console.log(`   O manualmente: tmux kill-session -t ${session.tmuxSessionName}\n`)

  } catch (error: any) {
    console.error('❌ Error:', error.message)
    console.error(error.stack)
    process.exit(1)
  }
}

// Ejecutar
testPuertoAntioquia()
