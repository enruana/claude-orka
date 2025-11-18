/**
 * Script de prueba rápida de Claude-Orka
 *
 * Ejecutar: npx tsx test-quick.ts
 */

import { ClaudeOrka, logger, LogLevel } from './src'

// Habilitar logs para ver qué está pasando
logger.setLevel(LogLevel.DEBUG)

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

async function testQuick() {
  console.log('🐋 Claude-Orka - Prueba Rápida\n')

  try {
    // 1. Crear instancia
    console.log('1️⃣  Creando instancia de ClaudeOrka...')
    const orka = new ClaudeOrka(process.cwd())
    await orka.initialize()
    console.log('   ✅ Instancia creada e inicializada\n')

    // 2. Crear sesión
    console.log('2️⃣  Creando sesión...')
    const session = await orka.createSession('test-session')
    console.log('   ✅ Sesión creada!')
    console.log(`   📛 ID: ${session.id}`)
    console.log(`   📛 Nombre: ${session.name}`)
    console.log(`   🖥️  tmux: ${session.tmuxSessionName}`)
    console.log(`   📍 Estado: ${session.status}\n`)

    // 3. Listar sesiones activas
    console.log('3️⃣  Listando sesiones activas...')
    const activeSessions = await orka.listSessions({ status: 'active' })
    console.log(`   📊 Total: ${activeSessions.length}`)
    activeSessions.forEach(s => {
      console.log(`      - ${s.name} (${s.id})`)
    })
    console.log()

    // 4. Esperar un poco para que Claude se inicialice
    console.log('4️⃣  Esperando 5 segundos para que Claude se inicialice...')
    await sleep(5000)
    console.log('   ✅ Listo\n')

    // 5. Crear un fork
    console.log('5️⃣  Creando fork...')
    const fork = await orka.createFork(session.id, 'test-fork')
    console.log('   ✅ Fork creado!')
    console.log(`   📛 ID: ${fork.id}`)
    console.log(`   📛 Nombre: ${fork.name}\n`)

    // 6. Esperar un poco
    console.log('6️⃣  Esperando 3 segundos...')
    await sleep(3000)
    console.log('   ✅ Listo\n')

    // 7. Obtener información de la sesión
    console.log('7️⃣  Obteniendo información actualizada de la sesión...')
    const updatedSession = await orka.getSession(session.id)
    if (updatedSession) {
      console.log(`   📊 Sesión: ${updatedSession.name}`)
      console.log(`   🍴 Forks: ${updatedSession.forks.length}`)
      updatedSession.forks.forEach(f => {
        console.log(`      - ${f.name} (${f.status})`)
      })
    }
    console.log()

    // 8. Cerrar fork
    console.log('8️⃣  Cerrando fork...')
    await orka.closeFork(session.id, fork.id, false) // No guardar contexto para ir rápido
    console.log('   ✅ Fork cerrado\n')

    // 9. Cerrar sesión
    console.log('9️⃣  Cerrando sesión...')
    await orka.closeSession(session.id, false) // No guardar contexto para ir rápido
    console.log('   ✅ Sesión cerrada\n')

    // 10. Verificar estado final
    console.log('🔟 Verificando estado final...')
    const finalSession = await orka.getSession(session.id)
    if (finalSession) {
      console.log(`   📍 Estado: ${finalSession.status}`)
    }
    console.log()

    console.log('✅ ¡Prueba completada exitosamente!\n')
    console.log('💡 Tips:')
    console.log('   - Revisa .claude-orka/state.json para ver el estado guardado')
    console.log('   - Usa "tmux list-sessions" para ver sesiones tmux')
    console.log('   - Ejecuta "npm run build" para compilar el proyecto\n')

  } catch (error: any) {
    console.error('❌ Error en la prueba:', error.message)
    console.error(error.stack)
    process.exit(1)
  }
}

// Ejecutar
testQuick()
