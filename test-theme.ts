import { ClaudeOrka } from './src/core/ClaudeOrka'

async function testTheme() {
  console.log('Testing Claude-Orka theme...')

  const orka = new ClaudeOrka('/Users/andres.mantilla/Desktop/Me/software-engineering/claude-orka')
  await orka.initialize()

  console.log('Creating test session...')
  const session = await orka.createSession('Theme Test', false) // Don't open terminal automatically

  console.log(`Session created: ${session.id}`)
  console.log(`tmux session: ${session.tmuxSessionId}`)
  console.log('\nTo see the theme:')
  console.log(`  tmux attach -t ${session.tmuxSessionId}`)
  console.log('\nPress Ctrl+B then D to detach when you\'re done viewing')
}

testTheme().catch(console.error)
