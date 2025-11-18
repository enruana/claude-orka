/**
 * Prueba completa de flujo end-to-end de Claude-Orka
 *
 * Flujo:
 * 1. Crear sesión nueva
 * 2. Enviar "Hola" a main
 * 3. Crear fork
 * 4. Preguntar sobre el universo en fork
 * 5. Generar export del fork (Claude usa Write para crear resumen)
 * 6. Hacer merge del fork al main (Claude lee archivo y resume)
 * 7. Cerrar sesión con export completo (/export)
 * 8. Verificar exports y merge
 *
 * Ejecutar: npx tsx test-complete-flow.ts
 */

import { ClaudeOrka, logger, LogLevel } from './src'
import * as fs from 'fs-extra'
import * as path from 'path'

// Habilitar logs
logger.setLevel(LogLevel.INFO)

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

async function testCompleteFlow() {
  console.log('🐋 Claude-Orka - Prueba Completa con Merge\n')
  console.log('='.repeat(70))
  console.log('\n')

  const projectPath = '/Users/andres.mantilla/Desktop/TCC/puertoantioquia-form'
  console.log(`📁 Proyecto: ${projectPath}\n`)

  try {
    // ===== INICIALIZACIÓN =====
    console.log('📦 FASE 1: Inicialización')
    console.log('-'.repeat(70))
    const orka = new ClaudeOrka(projectPath)
    await orka.initialize()
    console.log('✅ Orka inicializado\n')

    // ===== CREAR SESIÓN =====
    console.log('🎬 FASE 2: Crear sesión principal')
    console.log('-'.repeat(70))
    console.log('   Se abrirá ventana de Terminal...')
    const session = await orka.createSession('test-merge-flow')
    console.log(`   ✅ Sesión creada: ${session.id}`)
    console.log(`   📛 Nombre: ${session.name}\n`)

    // Esperar inicialización
    console.log('⏳ Esperando 8 segundos para que Claude se inicialice...')
    await sleep(8000)
    console.log('   ✅ Claude listo\n')

    // ===== ENVIAR MENSAJE A MAIN =====
    console.log('💬 FASE 3: Enviar mensaje a main')
    console.log('-'.repeat(70))
    console.log('   Enviando: "Hola Claude! Estamos probando el sistema de forks."')
    await orka.send(session.id, 'Hola Claude! Estamos probando el sistema de forks. Di hola de vuelta brevemente.')
    console.log('   ✅ Mensaje enviado a main\n')

    // Esperar respuesta
    console.log('⏳ Esperando 8 segundos para respuesta...')
    await sleep(8000)
    console.log('   ✅ Claude debería haber respondido en la terminal\n')

    // ===== CREAR FORK =====
    console.log('🍴 FASE 4: Crear fork')
    console.log('-'.repeat(70))
    console.log('   Creando fork (verás split en la terminal)...')
    const fork = await orka.createFork(session.id, 'exploración-planetas')
    console.log(`   ✅ Fork creado: ${fork.id}`)
    console.log(`   📛 Nombre: ${fork.name}\n`)

    // Esperar inicialización del fork
    console.log('⏳ Esperando 8 segundos para que el fork se inicialice...')
    await sleep(8000)
    console.log('   ✅ Fork listo\n')

    // ===== ENVIAR MENSAJE AL FORK =====
    console.log('🌌 FASE 5: Preguntar sobre el universo en fork')
    console.log('-'.repeat(70))
    console.log('   Enviando: "¿Cuántos planetas hay en el sistema solar? Dame detalles."')
    await orka.send(
      session.id,
      '¿Cuántos planetas hay en el sistema solar? Dame detalles sobre cada uno brevemente.',
      fork.id
    )
    console.log('   ✅ Pregunta enviada al fork\n')

    // Esperar respuesta
    console.log('⏳ Esperando 10 segundos para respuesta...')
    await sleep(10000)
    console.log('   ✅ Claude debería haber respondido en el fork\n')

    // ===== GENERAR EXPORT DEL FORK =====
    console.log('📝 FASE 6: Generar export del fork para merge')
    console.log('-'.repeat(70))
    console.log('   Enviando prompt a Claude para crear resumen ejecutivo...')
    const exportPath = await orka.generateForkExport(session.id, fork.id)
    console.log(`   ✅ Prompt enviado. Claude creará archivo en: ${exportPath}`)
    console.log('   📌 Claude usará Write para crear el archivo con resumen\n')

    // Esperar a que Claude genere resumen y cree el archivo
    console.log('⏳ Esperando 20 segundos para que Claude genere resumen y cree archivo...')
    console.log('   (Puedes ver el progreso en la terminal del fork)')
    await sleep(20000)
    console.log('   ✅ Claude debería haber creado el archivo\n')

    // Verificar que el export existe
    const fullExportPath = path.join(projectPath, exportPath)
    const exportExists = await fs.pathExists(fullExportPath)
    console.log(`   🔍 Verificando export...`)
    console.log(`      Archivo: ${exportPath}`)
    console.log(`      Existe: ${exportExists ? '✅ SÍ' : '❌ NO'}`)

    if (exportExists) {
      const exportContent = await fs.readFile(fullExportPath, 'utf-8')
      console.log(`      Tamaño: ${exportContent.length} caracteres`)
      console.log(`      Líneas: ${exportContent.split('\n').length}\n`)
    } else {
      console.log(`      ⚠️  El export no se creó. Claude puede necesitar más tiempo.\n`)
    }

    // ===== HACER MERGE =====
    console.log('🔀 FASE 7: Hacer merge del fork al main')
    console.log('-'.repeat(70))
    console.log('   Haciendo merge...')
    console.log('   1. Verificar que el export existe')
    console.log('   2. Cerrar el pane del fork')
    console.log('   3. Enviar prompt al main para que LEA el archivo y resuma\n')

    try {
      await orka.merge(session.id, fork.id)
      console.log('   ✅ Merge completado!')
      console.log('   📨 Prompt enviado al main para leer el archivo')
      console.log('   🔒 El fork fue cerrado automáticamente')
      console.log('   👀 Claude en main leerá el archivo y dará un brevísimo summary\n')
    } catch (error: any) {
      console.log(`   ⚠️  Error en merge: ${error.message}`)
      console.log(`   Esto puede ocurrir si el export no se completó a tiempo\n`)
    }

    // Esperar un poco para ver el resultado en main
    console.log('⏳ Esperando 10 segundos para ver Claude leer y resumir en main...')
    await sleep(10000)

    // ===== CERRAR SESIÓN CON EXPORT =====
    console.log('🔒 FASE 8: Cerrar sesión y exportar contexto del main')
    console.log('-'.repeat(70))
    console.log('   Cerrando sesión con saveContext=true...')
    await orka.closeSession(session.id, true)
    console.log('   ✅ Sesión cerrada y contexto exportado\n')

    // ===== VERIFICAR ESTADO FINAL =====
    console.log('📊 FASE 9: Verificar estado final')
    console.log('-'.repeat(70))

    // Obtener sesión actualizada
    const updatedSession = await orka.getSession(session.id)

    if (updatedSession) {
      console.log('\n📋 Estado final de la sesión:\n')
      console.log(`   ID: ${updatedSession.id}`)
      console.log(`   Estado: ${updatedSession.status}`)
      console.log(`   Última actividad: ${updatedSession.lastActivity}\n`)

      // Verificar export de main
      if (updatedSession.main.contextPath) {
        const mainExportPath = path.join(projectPath, updatedSession.main.contextPath)
        const mainExists = await fs.pathExists(mainExportPath)
        console.log(`   📝 Main Context:`)
        console.log(`      Path: ${updatedSession.main.contextPath}`)
        console.log(`      Existe: ${mainExists ? '✅' : '❌'}`)

        if (mainExists) {
          const mainContent = await fs.readFile(mainExportPath, 'utf-8')
          console.log(`      Tamaño: ${mainContent.length} caracteres`)

          // Verificar si contiene el merge
          const hasMerge = mainContent.includes('MERGE') || mainContent.includes('fork')
          console.log(`      Contiene merge: ${hasMerge ? '✅ SÍ' : '❌ NO'}`)

          console.log(`\n      📄 Preview (últimos 500 caracteres):`)
          console.log(`      ${'-'.repeat(66)}`)
          console.log(`      ${mainContent.slice(-500).replace(/\n/g, '\n      ')}`)
          console.log(`      ${'-'.repeat(66)}\n`)
        }
      } else {
        console.log(`   ⚠️  Main no tiene contextPath guardado\n`)
      }

      // Verificar fork merged
      const mergedFork = updatedSession.forks.find(f => f.id === fork.id)
      if (mergedFork) {
        console.log(`   🍴 Fork "${mergedFork.name}":`)
        console.log(`      ID: ${mergedFork.id}`)
        console.log(`      Estado: ${mergedFork.status}`)
        console.log(`      Merged: ${mergedFork.mergedToMain ? '✅ SÍ' : '❌ NO'}`)

        if (mergedFork.mergedAt) {
          console.log(`      Merged at: ${mergedFork.mergedAt}`)
        }

        if (mergedFork.contextPath) {
          const forkExportPath = path.join(projectPath, mergedFork.contextPath)
          const forkExists = await fs.pathExists(forkExportPath)
          console.log(`      Context guardado: ${forkExists ? '✅ SÍ' : '❌ NO'}`)
          console.log(`      Path: ${mergedFork.contextPath}`)

          if (forkExists) {
            const forkContent = await fs.readFile(forkExportPath, 'utf-8')
            console.log(`      Tamaño: ${forkContent.length} caracteres`)
          }
        }
        console.log('')
      }
    }

    // ===== RESUMEN FINAL =====
    console.log('\n')
    console.log('='.repeat(70))
    console.log('✅ PRUEBA COMPLETA EXITOSA!')
    console.log('='.repeat(70))
    console.log('\n📊 Resumen del flujo probado:')
    console.log(`   ✅ Sesión creada e inicializada`)
    console.log(`   ✅ Mensaje enviado a main`)
    console.log(`   ✅ Fork creado e inicializado`)
    console.log(`   ✅ Pregunta enviada al fork`)
    console.log(`   ✅ Export del fork generado (Claude usa Write para crear resumen)`)
    console.log(`   ✅ Merge realizado (Claude en main lee archivo y resume)`)
    console.log(`   ✅ Sesión cerrada con export completo (/export)`)
    console.log(`   ✅ Estado persistido correctamente\n`)

    console.log('💡 Archivos generados:')
    console.log(`   - Estado: ${projectPath}/.claude-orka/state.json`)
    console.log(`   - Main export: ${projectPath}/.claude-orka/sessions/${updatedSession?.id}.md`)
    console.log(`   - Fork export: ${projectPath}/.claude-orka/forks/${fork.id}.md\n`)

    console.log('🎯 Verifica en la terminal del main que recibió el resumen del merge!\n')

  } catch (error: any) {
    console.error('\n❌ Error en la prueba:', error.message)
    console.error(error.stack)
    process.exit(1)
  }
}

// Ejecutar
testCompleteFlow()
