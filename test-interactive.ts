/**
 * Prueba INTERACTIVA de Claude-Orka con Merge
 *
 * Este test valida el flujo completo de fork + merge:
 * 1. Crear sesión y enviar mensaje a main
 * 2. Crear fork y hacer pregunta
 * 3. Generar export del fork (Claude crea resumen con Write)
 * 4. Hacer merge (Claude en main lee archivo y resume)
 * 5. Cerrar sesión (export completo con /export)
 *
 * Tiene pausas entre cada paso. Presiona ENTER para continuar.
 *
 * Ejecutar: npx tsx test-interactive.ts
 */

import { ClaudeOrka, logger, LogLevel } from './src'
import * as fs from 'fs-extra'
import * as path from 'path'
import * as readline from 'readline'

// Habilitar logs
logger.setLevel(LogLevel.INFO)

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
})

// Función para esperar a que el usuario presione Enter
function waitForEnter(message: string = '\n▶️  Presiona ENTER para continuar...'): Promise<void> {
  return new Promise((resolve) => {
    rl.question(message, () => {
      resolve()
    })
  })
}

async function testInteractiveFlow() {
  console.log('🐋 Claude-Orka - Test INTERACTIVO con Merge\n')
  console.log('='.repeat(70))
  console.log('ℹ️  Este test tiene PAUSAS entre cada paso')
  console.log('ℹ️  Presiona ENTER cuando estés listo para el siguiente paso')
  console.log('='.repeat(70))
  console.log('\n')

  const projectPath = '/Users/andres.mantilla/Desktop/TCC/puertoantioquia-form'
  console.log(`📁 Proyecto: ${projectPath}\n`)

  try {
    // ===== INICIALIZACIÓN =====
    console.log('📦 PASO 1: Inicialización')
    console.log('-'.repeat(70))
    console.log('   Vamos a inicializar Orka en el proyecto')
    await waitForEnter()

    const orka = new ClaudeOrka(projectPath)
    await orka.initialize()
    console.log('   ✅ Orka inicializado')
    console.log('   📁 Estructura .claude-orka/ creada\n')

    // ===== MOSTRAR RESUMEN DEL PROYECTO =====
    console.log('📊 PASO 1.5: Resumen del estado actual del proyecto')
    console.log('-'.repeat(70))
    await waitForEnter('▶️  Presiona ENTER para ver el estado actual...')

    const summary = await orka.getProjectSummary()

    console.log(`\n   📁 Proyecto: ${summary.projectPath}`)
    console.log(`   📅 Última actualización: ${new Date(summary.lastUpdated).toLocaleString()}`)
    console.log(`\n   📊 Estadísticas:`)
    console.log(`      Total sesiones: ${summary.totalSessions}`)
    console.log(`      Sesiones activas: ${summary.activeSessions}`)
    console.log(`      Sesiones guardadas: ${summary.savedSessions}`)

    if (summary.sessions.length > 0) {
      console.log(`\n   📋 Sesiones existentes:`)
      summary.sessions.forEach((session, index) => {
        console.log(`\n   ${index + 1}. ${session.name} (${session.id})`)
        console.log(`      Estado: ${session.status}`)
        console.log(`      Creada: ${new Date(session.createdAt).toLocaleString()}`)
        console.log(`      Contexto main: ${session.hasMainContext ? '✅ Disponible' : '❌ No disponible'}`)
        if (session.mainContextPath) {
          console.log(`         Path: ${session.mainContextPath}`)
        }
        console.log(`      Forks: ${session.totalForks} total`)
        console.log(`         - Activos: ${session.activeForks}`)
        console.log(`         - Guardados: ${session.savedForks}`)
        console.log(`         - Mergeados: ${session.mergedForks}`)

        if (session.forks.length > 0) {
          console.log(`      Detalle de forks:`)
          session.forks.forEach((fork) => {
            const statusEmoji = fork.status === 'active' ? '🟢' : fork.status === 'merged' ? '🔀' : '💾'
            console.log(`         ${statusEmoji} ${fork.name} (${fork.id})`)
            console.log(`            Estado: ${fork.status}`)
            console.log(`            Contexto: ${fork.hasContext ? '✅ Disponible' : '❌ No disponible'}`)
            if (fork.mergedToMain) {
              console.log(`            Merged: ✅ Sí (${new Date(fork.mergedAt!).toLocaleString()})`)
            }
          })
        }
      })
    } else {
      console.log(`\n   ℹ️  No hay sesiones guardadas aún`)
    }

    await waitForEnter('\n▶️  Presiona ENTER para continuar...')
    console.log()

    // ===== DECIDIR ENTRE CREAR O RESTAURAR =====
    console.log('🎬 PASO 2: Crear o Restaurar sesión')
    console.log('-'.repeat(70))

    let session: any

    if (summary.sessions.length > 0) {
      console.log('   Opciones:')
      console.log('   1. Crear nueva sesión')
      console.log('   2. Restaurar sesión existente')

      const choice = await new Promise<string>((resolve) => {
        rl.question('\n▶️  Elige opción (1 o 2): ', (answer) => {
          resolve(answer.trim())
        })
      })

      if (choice === '2') {
        // Mostrar sesiones disponibles
        console.log('\n   📋 Sesiones disponibles para restaurar:')
        summary.sessions.forEach((s, index) => {
          console.log(`      ${index + 1}. ${s.name} (${s.id}) - ${s.status}`)
          console.log(`         Forks: ${s.totalForks} | Main context: ${s.hasMainContext ? '✅' : '❌'}`)
        })

        const sessionIndex = await new Promise<number>((resolve) => {
          rl.question('\n▶️  Elige sesión (número): ', (answer) => {
            resolve(parseInt(answer.trim()) - 1)
          })
        })

        const selectedSession = summary.sessions[sessionIndex]
        if (!selectedSession) {
          throw new Error('Sesión inválida')
        }

        console.log(`\n   🔄 Restaurando sesión: ${selectedSession.name}`)
        console.log('   Esto va a:')
        console.log('   1. Abrir sesión tmux')
        console.log('   2. Ejecutar "claude --continue"')
        console.log('   3. Cargar contexto del main (si existe)')
        console.log('   4. Restaurar forks guardados automáticamente')
        console.log('   5. Cargar contexto de cada fork (si existe)')
        await waitForEnter('▶️  Presiona ENTER para restaurar...')

        session = await orka.resumeSession(selectedSession.id)
        console.log(`   ✅ Sesión restaurada: ${session.id}`)
        console.log(`   📛 Nombre: ${session.name}`)
        console.log(`   🪟  Terminal debería haberse abierto`)
        if (selectedSession.totalForks > 0) {
          console.log(`   🍴 ${selectedSession.totalForks} fork(s) restaurado(s)`)
        }
      } else {
        // Crear nueva sesión
        console.log('\n   📝 Creando nueva sesión')
        console.log('   Esto va a:')
        console.log('   1. Crear una sesión tmux')
        console.log('   2. Ejecutar "claude --continue"')
        console.log('   3. Abrir Terminal.app automáticamente')
        await waitForEnter('▶️  Presiona ENTER para crear la sesión...')

        session = await orka.createSession('test-interactive-merge')
        console.log(`   ✅ Sesión creada: ${session.id}`)
        console.log(`   📛 Nombre: ${session.name}`)
        console.log(`   🪟  Terminal debería haberse abierto`)
      }
    } else {
      // No hay sesiones, crear una nueva
      console.log('   📝 Creando nueva sesión (no hay sesiones existentes)')
      console.log('   Esto va a:')
      console.log('   1. Crear una sesión tmux')
      console.log('   2. Ejecutar "claude --continue"')
      console.log('   3. Abrir Terminal.app automáticamente')
      await waitForEnter('▶️  Presiona ENTER para crear la sesión...')

      session = await orka.createSession('test-interactive-merge')
      console.log(`   ✅ Sesión creada: ${session.id}`)
      console.log(`   📛 Nombre: ${session.name}`)
      console.log(`   🪟  Terminal debería haberse abierto`)
    }

    await waitForEnter('▶️  Presiona ENTER cuando veas la terminal abierta con Claude...')

    // ===== ESPERAR CLAUDE LISTO =====
    console.log('⏳ PASO 3: Esperar a que Claude esté listo')
    console.log('-'.repeat(70))
    console.log('   Verifica en la terminal que:')
    console.log('   1. Claude haya terminado de cargar')
    console.log('   2. Veas el prompt >')
    console.log('   3. No haya errores')
    await waitForEnter('▶️  Presiona ENTER cuando Claude esté listo (prompt visible)...')
    console.log('   ✅ Claude listo\n')

    // ===== ENVIAR MENSAJE A MAIN =====
    console.log('💬 PASO 4: Enviar mensaje a main')
    console.log('-'.repeat(70))
    console.log('   Mensaje: "Hola! Estamos probando forks. Di hola brevemente."')
    await waitForEnter('▶️  Presiona ENTER para enviar el mensaje...')

    await orka.send(session.id, 'Hola! Estamos probando forks. Di hola brevemente.')
    console.log('   ✅ Mensaje enviado a Claude')
    await waitForEnter('▶️  Presiona ENTER cuando veas la respuesta de Claude en main...')
    console.log('   ✅ Claude respondió\n')

    // ===== CREAR FORK =====
    console.log('🍴 PASO 5: Crear fork')
    console.log('-'.repeat(70))
    console.log('   Esto va a:')
    console.log('   1. Hacer split horizontal de la ventana tmux')
    console.log('   2. Ejecutar "claude --continue" en el nuevo pane')
    console.log('   3. Enviar mensaje notificando que es un fork')
    await waitForEnter('▶️  Presiona ENTER para crear el fork...')

    const fork = await orka.createFork(session.id, 'test-planetas')
    console.log(`   ✅ Fork creado: ${fork.id}`)
    console.log(`   📛 Nombre: ${fork.name}`)
    console.log('   🪟  Deberías ver el split en la terminal')
    await waitForEnter('▶️  Presiona ENTER cuando veas el split y Claude cargando en el fork...')

    // ===== ESPERAR FORK LISTO =====
    console.log('⏳ PASO 6: Esperar a que el fork esté listo')
    console.log('-'.repeat(70))
    console.log('   Verifica en el fork (pane inferior) que:')
    console.log('   1. Claude haya terminado de cargar')
    console.log('   2. Veas el mensaje "Este es un fork llamado test-planetas"')
    console.log('   3. Veas el prompt >')
    await waitForEnter('▶️  Presiona ENTER cuando el fork esté listo...')
    console.log('   ✅ Fork listo\n')

    // ===== ENVIAR MENSAJE AL FORK =====
    console.log('🌌 PASO 7: Enviar pregunta al fork')
    console.log('-'.repeat(70))
    console.log('   Pregunta: "¿Cuántos planetas hay en el sistema solar?"')
    await waitForEnter('▶️  Presiona ENTER para enviar la pregunta al fork...')

    await orka.send(
      session.id,
      '¿Cuántos planetas hay en el sistema solar? Dame detalles brevemente.',
      fork.id
    )
    console.log('   ✅ Pregunta enviada al fork')
    await waitForEnter('▶️  Presiona ENTER cuando Claude haya respondido en el fork...')
    console.log('   ✅ Claude respondió en el fork\n')

    // ===== GENERAR EXPORT DEL FORK =====
    console.log('📝 PASO 8: Generar export del fork para merge')
    console.log('-'.repeat(70))
    console.log('   Esto va a enviar un prompt a Claude pidiendo:')
    console.log('   - Crear un archivo de contexto con resumen ejecutivo')
    console.log('   - Incluir: objetivo, desarrollo, hallazgos, resultados, recomendaciones')
    console.log('   - Usar la herramienta Write para crear el archivo')
    await waitForEnter('▶️  Presiona ENTER para enviar el prompt de export...')

    const exportPath = await orka.generateForkExport(session.id, fork.id)
    console.log(`   ✅ Prompt enviado a Claude en el fork`)
    console.log(`   📁 Claude creará el archivo en: ${exportPath}`)
    console.log('   👀 Observa en el fork cómo Claude procesa el prompt\n')

    // ===== ESPERAR EXPORT =====
    console.log('⏳ PASO 9: Esperar a que Claude complete el export')
    console.log('-'.repeat(70))
    console.log('   Observa en el fork que Claude:')
    console.log('   1. Lee y entiende el prompt')
    console.log('   2. Analiza la conversación del fork')
    console.log('   3. Genera el resumen ejecutivo')
    console.log('   4. Usa la herramienta Write para crear el archivo')
    console.log('   5. Confirma que lo guardó')
    await waitForEnter('▶️  Presiona ENTER cuando veas que Claude confirmó crear el archivo...')
    console.log('   ✅ Claude completó el export\n')

    // ===== VERIFICAR ARCHIVO =====
    console.log('🔍 PASO 10: Verificar que el archivo fue creado')
    console.log('-'.repeat(70))
    await waitForEnter('▶️  Presiona ENTER para verificar el archivo...')

    const fullExportPath = path.join(projectPath, exportPath)
    const exportExists = await fs.pathExists(fullExportPath)
    console.log(`   Archivo: ${exportPath}`)
    console.log(`   Existe: ${exportExists ? '✅ SÍ' : '❌ NO'}`)

    if (exportExists) {
      const exportContent = await fs.readFile(fullExportPath, 'utf-8')
      console.log(`   Tamaño: ${exportContent.length} caracteres`)
      console.log(`   Preview (primeras 3 líneas):`)
      const lines = exportContent.split('\n').slice(0, 3)
      lines.forEach(line => console.log(`      ${line}`))
      await waitForEnter('▶️  Presiona ENTER para continuar al merge...')
    } else {
      console.log(`   ⚠️  El export NO existe!`)
      console.log(`   Claude probablemente necesita más tiempo o hubo un error`)
      await waitForEnter('▶️  Presiona ENTER para intentar el merge de todos modos...')
    }

    // ===== HACER MERGE =====
    console.log('🔀 PASO 11: Hacer merge del fork al main')
    console.log('-'.repeat(70))
    console.log('   Esto va a:')
    console.log('   1. Verificar que el export existe')
    console.log('   2. Cerrar el pane del fork')
    console.log('   3. Enviar prompt al main pidiendo que LEA el archivo y resuma')
    console.log('   4. Marcar fork como merged en el estado')
    await waitForEnter('▶️  Presiona ENTER para ejecutar el merge...')

    try {
      await orka.merge(session.id, fork.id)
      console.log('   ✅ Merge ejecutado!')
      console.log('   📨 Prompt enviado al main')
      console.log('   🔒 El pane del fork se cerró')
      console.log('   👀 Ahora observa el main\n')
    } catch (error: any) {
      console.log(`   ❌ Error en merge: ${error.message}\n`)
    }

    // ===== VERIFICAR MERGE EN MAIN =====
    console.log('👁️  PASO 12: Verificar el merge en main')
    console.log('-'.repeat(70))
    console.log('   En la terminal del main deberías ver:')
    console.log('   1. El prompt de merge que menciona el archivo del fork')
    console.log('   2. Claude usando Read para leer el archivo')
    console.log('   3. Claude generando un brevísimo summary')
    await waitForEnter('▶️  Presiona ENTER cuando hayas visto el summary de Claude en main...')
    console.log('   ✅ Merge verificado - Fork integrado en main\n')

    // ===== CERRAR SESIÓN =====
    console.log('🔒 PASO 13: Cerrar sesión y exportar')
    console.log('-'.repeat(70))
    console.log('   Esto va a:')
    console.log('   1. Enviar comando /export en el main')
    console.log('   2. Copiar el contexto completo al clipboard')
    console.log('   3. Guardar en .claude-orka/sessions/')
    console.log('   4. Cerrar el pane de tmux')
    await waitForEnter('▶️  Presiona ENTER para cerrar la sesión...')

    await orka.closeSession(session.id, true)
    console.log('   ✅ Sesión cerrada')
    console.log('   💾 Contexto exportado\n')

    // ===== VERIFICAR ESTADO FINAL =====
    console.log('📊 PASO 14: Verificar estado final')
    console.log('-'.repeat(70))
    await waitForEnter('▶️  Presiona ENTER para ver el estado final...')

    const updatedSession = await orka.getSession(session.id)

    if (updatedSession) {
      console.log('\n📋 Estado final:\n')
      console.log(`   Sesión: ${updatedSession.id}`)
      console.log(`   Estado: ${updatedSession.status}`)

      // Verificar fork
      const mergedFork = updatedSession.forks.find(f => f.id === fork.id)
      if (mergedFork) {
        console.log(`\n   🍴 Fork "${mergedFork.name}":`)
        console.log(`      Estado: ${mergedFork.status}`)
        console.log(`      Merged: ${mergedFork.mergedToMain ? '✅ SÍ' : '❌ NO'}`)
        console.log(`      Export guardado: ${mergedFork.contextPath ? '✅ SÍ' : '❌ NO'}`)
      }

      // Verificar main export
      if (updatedSession.main.contextPath) {
        const mainPath = path.join(projectPath, updatedSession.main.contextPath)
        const mainExists = await fs.pathExists(mainPath)
        console.log(`\n   📝 Main export:`)
        console.log(`      Existe: ${mainExists ? '✅ SÍ' : '❌ NO'}`)
        console.log(`      Path: ${updatedSession.main.contextPath}`)

        if (mainExists) {
          const content = await fs.readFile(mainPath, 'utf-8')
          const hasMerge = content.includes('MERGE') || content.includes('planetas')
          console.log(`      Contiene merge: ${hasMerge ? '✅ SÍ' : '❌ NO'}`)
        }
      }
    }

    // ===== RESUMEN =====
    console.log('\n')
    console.log('='.repeat(70))
    console.log('✅ TEST INTERACTIVO COMPLETO!')
    console.log('='.repeat(70))
    console.log('\n📊 Flujo probado en 14 pasos:')
    console.log('   ✅ 1. Orka inicializado')
    console.log('   ✅ 2. Sesión creada')
    console.log('   ✅ 3. Claude listo en main')
    console.log('   ✅ 4. Mensaje enviado y respondido en main')
    console.log('   ✅ 5. Fork creado (split)')
    console.log('   ✅ 6. Claude listo en fork')
    console.log('   ✅ 7. Pregunta enviada y respondida en fork')
    console.log('   ✅ 8. Export generado (Claude usa Write)')
    console.log('   ✅ 9. Claude completó el export')
    console.log('   ✅ 10. Archivo verificado')
    console.log('   ✅ 11. Merge ejecutado')
    console.log('   ✅ 12. Merge verificado en main')
    console.log('   ✅ 13. Sesión cerrada con export (/export)')
    console.log('   ✅ 14. Estado final verificado\n')

    console.log('💡 Archivos generados:')
    console.log(`   - ${projectPath}/.claude-orka/state.json`)
    console.log(`   - ${projectPath}/.claude-orka/sessions/${updatedSession?.id}.md`)
    console.log(`   - ${projectPath}/.claude-orka/forks/${fork.id}.md\n`)

    rl.close()

  } catch (error: any) {
    console.error('\n❌ Error:', error.message)
    console.error(error.stack)
    rl.close()
    process.exit(1)
  }
}

// Ejecutar
testInteractiveFlow()
