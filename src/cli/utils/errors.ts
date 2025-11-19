import chalk from 'chalk'
import fs from 'fs'
import path from 'path'
import { Output } from './output'

/**
 * CLI Error Handler
 */
export class CLIError extends Error {
  constructor(
    message: string,
    public exitCode: number = 1
  ) {
    super(message)
    this.name = 'CLIError'
  }
}

/**
 * Handle CLI errors
 */
export function handleError(error: unknown): never {
  if (error instanceof CLIError) {
    Output.error(error.message)
    process.exit(error.exitCode)
  }

  if (error instanceof Error) {
    Output.error(`Unexpected error: ${error.message}`)
    console.error(chalk.gray(error.stack))
    process.exit(1)
  }

  Output.error('An unknown error occurred')
  process.exit(1)
}

/**
 * Validate session ID format
 */
export function validateSessionId(sessionId: string): void {
  if (!sessionId || sessionId.length === 0) {
    throw new CLIError('Session ID is required')
  }
}

/**
 * Validate fork ID format
 */
export function validateForkId(forkId: string): void {
  if (!forkId || forkId.length === 0) {
    throw new CLIError('Fork ID is required')
  }
}

/**
 * Validate project is initialized
 */
export function validateInitialized(projectPath: string): void {
  const orkaDir = path.join(projectPath, '.claude-orka')

  if (!fs.existsSync(orkaDir)) {
    throw new CLIError(
      'Project not initialized. Run "orka init" first.',
      2
    )
  }
}
