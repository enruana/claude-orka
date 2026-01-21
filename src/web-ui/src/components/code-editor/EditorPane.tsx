import Editor from '@monaco-editor/react'
import { useRef, useCallback } from 'react'
import type { editor } from 'monaco-editor'

interface EditorPaneProps {
  content: string
  filePath: string
  onChange: (content: string) => void
  readOnly?: boolean
}

// Map file extensions to Monaco language IDs
function getLanguageFromPath(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() || ''

  const languageMap: Record<string, string> = {
    // JavaScript/TypeScript
    'js': 'javascript',
    'jsx': 'javascript',
    'ts': 'typescript',
    'tsx': 'typescript',
    'mjs': 'javascript',
    'cjs': 'javascript',

    // Web
    'html': 'html',
    'htm': 'html',
    'css': 'css',
    'scss': 'scss',
    'sass': 'scss',
    'less': 'less',

    // Data formats
    'json': 'json',
    'jsonc': 'json',
    'yaml': 'yaml',
    'yml': 'yaml',
    'xml': 'xml',
    'toml': 'toml',

    // Scripting
    'py': 'python',
    'rb': 'ruby',
    'php': 'php',
    'sh': 'shell',
    'bash': 'shell',
    'zsh': 'shell',
    'ps1': 'powershell',

    // Systems
    'go': 'go',
    'rs': 'rust',
    'c': 'c',
    'cpp': 'cpp',
    'h': 'c',
    'hpp': 'cpp',
    'java': 'java',
    'kt': 'kotlin',
    'swift': 'swift',
    'cs': 'csharp',

    // Config
    'md': 'markdown',
    'mdx': 'markdown',
    'dockerfile': 'dockerfile',
    'makefile': 'makefile',
    'ini': 'ini',
    'env': 'ini',

    // SQL
    'sql': 'sql',

    // GraphQL
    'graphql': 'graphql',
    'gql': 'graphql',
  }

  // Handle special filenames
  const filename = filePath.split('/').pop()?.toLowerCase() || ''
  if (filename === 'dockerfile') return 'dockerfile'
  if (filename === 'makefile') return 'makefile'
  if (filename.startsWith('.env')) return 'ini'
  if (filename === '.gitignore') return 'ini'

  return languageMap[ext] || 'plaintext'
}

export function EditorPane({ content, filePath, onChange, readOnly = false }: EditorPaneProps) {
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null)

  const handleEditorMount = useCallback((editor: editor.IStandaloneCodeEditor) => {
    editorRef.current = editor

    // Focus editor when mounted
    editor.focus()
  }, [])

  const handleEditorChange = useCallback((value: string | undefined) => {
    if (value !== undefined) {
      onChange(value)
    }
  }, [onChange])

  const language = getLanguageFromPath(filePath)

  return (
    <div className="editor-pane">
      <Editor
        height="100%"
        language={language}
        value={content}
        onChange={handleEditorChange}
        onMount={handleEditorMount}
        theme="vs-dark"
        options={{
          readOnly,
          fontSize: 13,
          fontFamily: "'SF Mono', Monaco, 'Courier New', monospace",
          fontLigatures: true,
          minimap: { enabled: true, scale: 0.8 },
          scrollBeyondLastLine: false,
          wordWrap: 'off',
          lineNumbers: 'on',
          renderWhitespace: 'selection',
          tabSize: 2,
          insertSpaces: true,
          automaticLayout: true,
          bracketPairColorization: { enabled: true },
          smoothScrolling: true,
          cursorBlinking: 'smooth',
          cursorSmoothCaretAnimation: 'on',
          padding: { top: 8, bottom: 8 },
          folding: true,
          foldingStrategy: 'indentation',
          showFoldingControls: 'mouseover',
          links: true,
          contextmenu: true,
          quickSuggestions: true,
          suggestOnTriggerCharacters: true,
          acceptSuggestionOnEnter: 'smart',
          formatOnPaste: true,
          formatOnType: false,
        }}
      />
    </div>
  )
}
