/**
 * Ejemplo básico de uso de Claude-Orka
 *
 * Para ejecutar:
 * npx tsx examples/basic.ts
 */

import { ClaudeOrka, logger, LogLevel } from '../src'

// Configurar logs
logger.setLevel(LogLevel.INFO)

async function main() {
  console.log('🐋 Claude-Orka - Ejemplo Básico\n')

  // Crear instancia de Orka para el proyecto actual
  const projectPath = process.cwd()
  console.log(`📁 Proyecto: ${projectPath}\n`)

  const orka = new ClaudeOrka(projectPath)
  await orka.initialize()

  // 1. Crear una nueva sesión
  console.log('1️⃣  Creando nueva sesión...')
  const session = await orka.createSession('demo-session')
  console.log(`   ✅ Sesión creada: ${session.id}`)
  console.log(`   📛 Nombre: ${session.name}`)
  console.log(`   🖥️  tmux: ${session.tmuxSessionName}\n`)

  // Esperar un poco para que Claude se inicialice
  await sleep(3000)

  // 2. Enviar comando a la sesión principal
  console.log('2️⃣  Enviando comando a main...')
  await orka.send(session.id, 'Hola! Estoy probando Claude-Orka. Responde brevemente.')
  console.log('   ✅ Comando enviado\n')

  await sleep(5000)

  // 3. Crear un fork
  console.log('3️⃣  Creando fork...')
  const fork = await orka.createFork(session.id, 'testing-fork')
  console.log(`   ✅ Fork creado: ${fork.id}`)
  console.log(`   📛 Nombre: ${fork.name}\n`)

  await sleep(3000)

  // 4. Enviar comando al fork
  console.log('4️⃣  Enviando comando al fork...')
  await orka.send(
    session.id,
    'Este es un fork de prueba. Responde brevemente.',
    fork.id
  )
  console.log('   ✅ Comando enviado al fork\n')

  await sleep(5000)

  // 5. Exportar el fork
  console.log('5️⃣  Exportando contexto del fork...')
  const exportPath = await orka.export(session.id, fork.id)
  console.log(`   ✅ Contexto exportado: ${exportPath}\n`)

  await sleep(2000)

  // 6. Hacer merge del fork a main
  console.log('6️⃣  Haciendo merge del fork a main...')
  await orka.merge(session.id, fork.id)
  console.log('   ✅ Merge completado\n')

  await sleep(2000)

  // 7. Cerrar el fork
  console.log('7️⃣  Cerrando fork...')
  await orka.closeFork(session.id, fork.id)
  console.log('   ✅ Fork cerrado\n')

  // 8. Listar sesiones
  console.log('8️⃣  Listando sesiones activas...')
  const activeSessions = await orka.listSessions({ status: 'active' })
  console.log(`   📊 Sesiones activas: ${activeSessions.length}`)
  activeSessions.forEach(s => {
    console.log(`      - ${s.name} (${s.id})`)
  })
  console.log()

  // 9. Cerrar la sesión
  console.log('9️⃣  Cerrando sesión (guardando contexto)...')
  await orka.closeSession(session.id)
  console.log('   ✅ Sesión cerrada y contexto guardado\n')

  // 10. Listar sesiones guardadas
  console.log('🔟 Listando sesiones guardadas...')
  const savedSessions = await orka.listSessions({ status: 'saved' })
  console.log(`   📊 Sesiones guardadas: ${savedSessions.length}`)
  savedSessions.forEach(s => {
    console.log(`      - ${s.name} (${s.id})`)
    if (s.main.contextPath) {
      console.log(`        📄 Contexto: ${s.main.contextPath}`)
    }
  })
  console.log()

  console.log('✅ Demo completada!')
  console.log('\n💡 Tips:')
  console.log('   - Puedes restaurar la sesión con: orka.resumeSession(sessionId)')
  console.log('   - Revisa .claude-orka/ para ver los contextos guardados')
  console.log('   - Usa tmux attach -t orchestrator-{sessionId} para ver la sesión\n')
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// Ejecutar
main().catch(error => {
  console.error('❌ Error:', error)
  process.exit(1)
})
