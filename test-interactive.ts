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
    await waitForEnter()

    const orka = new ClaudeOrka(projectPath)
    await orka.initialize()
    console.log('✅ Orka inicializado\n')

    // ===== CREAR SESIÓN =====
    console.log('🎬 PASO 2: Crear sesión principal')
    console.log('-'.repeat(70))
    console.log('   Se abrirá ventana de Terminal...')
    await waitForEnter()

    const session = await orka.createSession('test-interactive-merge')
    console.log(`   ✅ Sesión creada: ${session.id}`)
    console.log(`   📛 Nombre: ${session.name}`)
    console.log(`   🪟  Revisa que la terminal se haya abierto\n`)

    // ===== ENVIAR MENSAJE A MAIN =====
    console.log('💬 PASO 3: Enviar mensaje a main')
    console.log('-'.repeat(70))
    console.log('   Mensaje: "Hola! Estamos probando forks."')
    await waitForEnter('▶️  Presiona ENTER cuando Claude esté listo (prompt visible)...')

    await orka.send(session.id, 'Hola! Estamos probando forks. Di hola brevemente.')
    console.log('   ✅ Mensaje enviado')
    console.log('   👀 Verifica que Claude responda en el main\n')

    // ===== CREAR FORK =====
    console.log('🍴 PASO 4: Crear fork')
    console.log('-'.repeat(70))
    console.log('   Se hará split de la ventana...')
    await waitForEnter('▶️  Presiona ENTER cuando Claude haya respondido en main...')

    const fork = await orka.createFork(session.id, 'test-planetas')
    console.log(`   ✅ Fork creado: ${fork.id}`)
    console.log(`   📛 Nombre: ${fork.name}`)
    console.log('   🪟  Deberías ver el split en la terminal')
    console.log('   ⏳ El fork se está inicializando...\n')

    // ===== ENVIAR MENSAJE AL FORK =====
    console.log('🌌 PASO 5: Enviar pregunta al fork')
    console.log('-'.repeat(70))
    console.log('   Pregunta: "¿Cuántos planetas hay en el sistema solar?"')
    await waitForEnter('▶️  Presiona ENTER cuando el fork esté listo (deberías ver el mensaje de fork)...')

    await orka.send(
      session.id,
      '¿Cuántos planetas hay en el sistema solar? Dame detalles brevemente.',
      fork.id
    )
    console.log('   ✅ Pregunta enviada al fork')
    console.log('   👀 Verifica que Claude responda en el fork\n')

    // ===== GENERAR EXPORT DEL FORK =====
    console.log('📝 PASO 6: Generar export del fork para merge')
    console.log('-'.repeat(70))
    console.log('   Esto enviará un prompt a Claude pidiendo:')
    console.log('   - Crear un archivo de contexto con resumen ejecutivo')
    console.log('   - Incluir: objetivo, desarrollo, hallazgos, resultados, recomendaciones')
    console.log('   - Usar la herramienta Write para crear el archivo')
    await waitForEnter('▶️  Presiona ENTER cuando Claude haya respondido la pregunta...')

    const exportPath = await orka.generateForkExport(session.id, fork.id)
    console.log(`   ✅ Prompt enviado a Claude`)
    console.log(`   📁 Claude creará el archivo en: ${exportPath}`)
    console.log('   👀 En el fork verás a Claude generando el resumen y usando Write\n')

    // ===== ESPERAR EXPORT =====
    console.log('⏳ PASO 7: Esperar a que Claude complete el export')
    console.log('-'.repeat(70))
    console.log('   Claude está:')
    console.log('   1. Leyendo la conversación del fork')
    console.log('   2. Generando el resumen ejecutivo')
    console.log('   3. Usando Write para crear el archivo')
    console.log('   4. Confirmando que lo guardó')
    await waitForEnter('▶️  Presiona ENTER cuando veas que Claude confirmó crear el archivo...')

    // Verificar export
    const fullExportPath = path.join(projectPath, exportPath)
    const exportExists = await fs.pathExists(fullExportPath)
    console.log(`\n   🔍 Verificando export...`)
    console.log(`      Existe: ${exportExists ? '✅ SÍ' : '❌ NO'}`)

    if (exportExists) {
      const exportContent = await fs.readFile(fullExportPath, 'utf-8')
      console.log(`      Tamaño: ${exportContent.length} caracteres`)
      console.log(`      Preview (primeras líneas):`)
      const preview = exportContent.split('\n').slice(0, 5).join('\n')
      console.log(`      ${preview.substring(0, 200)}...\n`)
    } else {
      console.log(`      ⚠️  El export aún no existe. Espera más tiempo.\n`)
    }

    // ===== HACER MERGE =====
    console.log('🔀 PASO 8: Hacer merge del fork al main')
    console.log('-'.repeat(70))
    console.log('   Esto hará:')
    console.log('   1. Verificar que el export existe')
    console.log('   2. Cerrar el pane del fork')
    console.log('   3. Enviar prompt al main pidiendo que LEA el archivo y resuma')
    console.log('   4. Marcar fork como merged')
    await waitForEnter()

    try {
      await orka.merge(session.id, fork.id)
      console.log('   ✅ Merge completado!')
      console.log('   👀 Verifica en el MAIN que Claude leyó el archivo')
      console.log('   🔒 El fork se cerró automáticamente\n')
    } catch (error: any) {
      console.log(`   ⚠️  Error en merge: ${error.message}\n`)
    }

    // ===== VERIFICAR MERGE EN MAIN =====
    console.log('👁️  PASO 9: Verificar el merge en main')
    console.log('-'.repeat(70))
    console.log('   En el main deberías ver:')
    console.log('   1. El prompt de merge que pide leer el archivo')
    console.log('   2. Claude leyendo el archivo del fork')
    console.log('   3. Claude dando un brevísimo summary')
    await waitForEnter('▶️  Presiona ENTER cuando hayas visto el summary de Claude en main...')
    console.log('   ✅ Merge verificado\n')

    // ===== CERRAR SESIÓN =====
    console.log('🔒 PASO 10: Cerrar sesión y exportar')
    console.log('-'.repeat(70))
    await waitForEnter()

    await orka.closeSession(session.id, true)
    console.log('   ✅ Sesión cerrada y exportada\n')

    // ===== VERIFICAR ESTADO FINAL =====
    console.log('📊 PASO 11: Verificar estado final')
    console.log('-'.repeat(70))
    await waitForEnter()

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
    console.log('\n📊 Flujo probado:')
    console.log('   ✅ Sesión creada e inicializada')
    console.log('   ✅ Mensaje enviado a main')
    console.log('   ✅ Fork creado e inicializado')
    console.log('   ✅ Pregunta enviada al fork')
    console.log('   ✅ Export generado (Claude usa Write para crear resumen)')
    console.log('   ✅ Merge realizado (Claude en main lee archivo y resume)')
    console.log('   ✅ Sesión cerrada con export completo (/export)\n')

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
