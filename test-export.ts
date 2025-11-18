/**
 * Prueba específica del comando /export de Claude
 *
 * Este test verifica que el nuevo método de export funcione correctamente
 * usando el comando /export de Claude en lugar de capture-pane
 *
 * Ejecutar: npx tsx test-export.ts
 */

import { ClaudeOrka, logger, LogLevel } from './src'
import * as fs from 'fs-extra'
import * as path from 'path'

// Habilitar logs completos
logger.setLevel(LogLevel.DEBUG)

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

async function testExport() {
  console.log('\n🔬 Prueba del comando /export de Claude\n')
  console.log('═'.repeat(70))
  console.log('\n')

  const projectPath = '/Users/andres.mantilla/Desktop/TCC/puertoantioquia-form'

  try {
    // Inicializar
    console.log('📦 Inicializando...')
    const orka = new ClaudeOrka(projectPath)
    await orka.initialize()
    console.log('✅ Inicializado\n')

    // Crear sesión
    console.log('🎬 Creando sesión...')
    const session = await orka.createSession('test-export')
    console.log(`✅ Sesión: ${session.id}\n`)

    // Esperar inicialización
    console.log('⏳ Esperando 8 segundos para Claude...')
    await sleep(8000)
    console.log('✅ Claude listo\n')

    // Enviar mensaje simple
    console.log('💬 Enviando mensaje de prueba...')
    await orka.send(session.id, 'Hola! Solo di "Hola de vuelta" y nada más.')
    console.log('✅ Mensaje enviado\n')

    // Esperar respuesta
    console.log('⏳ Esperando 8 segundos para respuesta...')
    await sleep(8000)
    console.log('✅ Respuesta recibida\n')

    // CERRAR CON EXPORT (esto usará el nuevo método)
    console.log('💾 Cerrando sesión con export...')
    console.log('   Esto usará: /export <ruta-completa>')
    console.log('   Claude debería guardar el archivo directamente\n')

    await orka.closeSession(session.id, true)
    console.log('✅ Sesión cerrada\n')

    // Verificar export
    console.log('🔍 Verificando export...')
    console.log('─'.repeat(70))

    const updatedSession = await orka.getSession(session.id)

    if (updatedSession?.main.contextPath) {
      const exportPath = path.join(projectPath, updatedSession.main.contextPath)
      const exists = await fs.pathExists(exportPath)

      console.log(`\n📄 Archivo: ${updatedSession.main.contextPath}`)
      console.log(`   Existe: ${exists ? '✅ SÍ' : '❌ NO'}`)

      if (exists) {
        const stats = await fs.stat(exportPath)
        const content = await fs.readFile(exportPath, 'utf-8')

        console.log(`   Tamaño: ${stats.size} bytes`)
        console.log(`   Líneas: ${content.split('\n').length}`)

        // Verificar contenido
        const hasMessage = content.includes('Hola')
        console.log(`   Contiene mensaje: ${hasMessage ? '✅ SÍ' : '❌ NO'}`)

        // Mostrar preview
        console.log(`\n   📝 Preview (primeras 300 caracteres):`)
        console.log('   ' + '-'.repeat(66))
        console.log('   ' + content.substring(0, 300).replace(/\n/g, '\n   '))
        console.log('   ' + '-'.repeat(66))
      }
    } else {
      console.log('❌ No se guardó contextPath')
    }

    console.log('\n')
    console.log('═'.repeat(70))
    console.log('✅ Prueba completada')
    console.log('═'.repeat(70))
    console.log('\n💡 Revisa si el export capturó toda la conversación correctamente\n')

  } catch (error: any) {
    console.error('\n❌ Error:', error.message)
    console.error(error.stack)
    process.exit(1)
  }
}

// Ejecutar
testExport()
