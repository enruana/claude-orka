import { useState, useCallback, useRef, useEffect } from 'react'
import { Search, ChevronRight, ChevronDown, FileText, Loader2 } from 'lucide-react'
import { api, SearchFileResult } from '../../api/client'

interface SearchPanelProps {
  encodedPath: string
  onResultClick: (filePath: string, line: number) => void
}

export function SearchPanel({ encodedPath, onResultClick }: SearchPanelProps) {
  const [query, setQuery] = useState('')
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [regex, setRegex] = useState(false)
  const [results, setResults] = useState<SearchFileResult[]>([])
  const [totalMatches, setTotalMatches] = useState(0)
  const [truncated, setTruncated] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [collapsedFiles, setCollapsedFiles] = useState<Set<string>>(new Set())
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const doSearch = useCallback(async (searchQuery: string, cs: boolean, rx: boolean) => {
    if (searchQuery.length < 2) {
      setResults([])
      setTotalMatches(0)
      setTruncated(false)
      setError(null)
      return
    }

    setLoading(true)
    setError(null)
    try {
      const response = await api.searchFiles(encodedPath, searchQuery, {
        caseSensitive: cs,
        regex: rx,
      })
      setResults(response.results)
      setTotalMatches(response.totalMatches)
      setTruncated(response.truncated)
      setCollapsedFiles(new Set())
    } catch (err: any) {
      setError(err.message)
      setResults([])
      setTotalMatches(0)
    } finally {
      setLoading(false)
    }
  }, [encodedPath])

  const scheduleSearch = useCallback((searchQuery: string, cs: boolean, rx: boolean) => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      doSearch(searchQuery, cs, rx)
    }, 300)
  }, [doSearch])

  // Cleanup debounce on unmount
  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [])

  // Focus input on mount
  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const handleQueryChange = (value: string) => {
    setQuery(value)
    scheduleSearch(value, caseSensitive, regex)
  }

  const handleToggleCaseSensitive = () => {
    const next = !caseSensitive
    setCaseSensitive(next)
    if (query.length >= 2) doSearch(query, next, regex)
  }

  const handleToggleRegex = () => {
    const next = !regex
    setRegex(next)
    if (query.length >= 2) doSearch(query, caseSensitive, next)
  }

  const toggleFileCollapsed = (filePath: string) => {
    setCollapsedFiles(prev => {
      const next = new Set(prev)
      if (next.has(filePath)) {
        next.delete(filePath)
      } else {
        next.add(filePath)
      }
      return next
    })
  }

  const highlightMatch = (text: string, searchQuery: string, isRegex: boolean, isCaseSensitive: boolean) => {
    if (!searchQuery) return text

    try {
      const flags = isCaseSensitive ? 'g' : 'gi'
      const pattern = isRegex ? new RegExp(searchQuery, flags) : new RegExp(escapeRegExp(searchQuery), flags)

      const parts: { text: string; highlighted: boolean }[] = []
      let lastIndex = 0
      let match: RegExpExecArray | null

      while ((match = pattern.exec(text)) !== null) {
        if (match.index > lastIndex) {
          parts.push({ text: text.slice(lastIndex, match.index), highlighted: false })
        }
        parts.push({ text: match[0], highlighted: true })
        lastIndex = match.index + match[0].length
        if (match[0].length === 0) break // prevent infinite loop on zero-length match
      }

      if (lastIndex < text.length) {
        parts.push({ text: text.slice(lastIndex), highlighted: false })
      }

      if (parts.length === 0) return text

      return (
        <>
          {parts.map((part, i) =>
            part.highlighted ? <mark key={i}>{part.text}</mark> : <span key={i}>{part.text}</span>
          )}
        </>
      )
    } catch {
      return text
    }
  }

  const fileCount = results.length
  const matchCount = totalMatches

  return (
    <div className="search-panel">
      <div className="search-input-row">
        <div className="search-input-wrapper">
          <Search size={14} className="search-input-icon" />
          <input
            ref={inputRef}
            type="text"
            className="search-input"
            placeholder="Search files..."
            value={query}
            onChange={(e) => handleQueryChange(e.target.value)}
          />
          {loading && <Loader2 size={14} className="search-spinner" />}
        </div>
        <button
          className={`search-toggle ${caseSensitive ? 'active' : ''}`}
          onClick={handleToggleCaseSensitive}
          title="Match Case"
        >
          Aa
        </button>
        <button
          className={`search-toggle ${regex ? 'active' : ''}`}
          onClick={handleToggleRegex}
          title="Use Regular Expression"
        >
          .*
        </button>
      </div>

      {error && (
        <div className="search-error">{error}</div>
      )}

      {query.length >= 2 && !loading && !error && (
        <div className="search-status">
          {matchCount === 0 ? (
            <span>No results found</span>
          ) : (
            <>
              <span>{matchCount} result{matchCount !== 1 ? 's' : ''} in {fileCount} file{fileCount !== 1 ? 's' : ''}</span>
              {truncated && <span className="search-truncated">Results limited</span>}
            </>
          )}
        </div>
      )}

      <div className="search-results">
        {results.map((file) => {
          const isCollapsed = collapsedFiles.has(file.path)
          const fileName = file.path.split('/').pop() || file.path

          return (
            <div key={file.path} className="search-file-group">
              <div
                className="search-file-header"
                onClick={() => toggleFileCollapsed(file.path)}
              >
                {isCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                <FileText size={14} className="search-file-icon" />
                <span className="search-file-name">{fileName}</span>
                <span className="search-file-path">{file.path}</span>
                <span className="search-file-count">{file.matches.length}</span>
              </div>
              {!isCollapsed && (
                <div className="search-file-matches">
                  {file.matches.map((match, idx) => (
                    <div
                      key={`${match.line}-${idx}`}
                      className="search-match-row"
                      onClick={() => onResultClick(file.path, match.line)}
                    >
                      <span className="search-match-line">{match.line}</span>
                      <span className="search-match-text">
                        {highlightMatch(match.text, query, regex, caseSensitive)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
