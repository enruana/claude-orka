export interface PrintFileOptions {
  content: string
  fileName: string
  filePath: string
  fileType: 'markdown' | 'code' | 'image' | 'other'
  language?: string
  monaco?: any
  renderedHtml?: string
  imageUrl?: string
}

export async function printFile(opts: PrintFileOptions): Promise<void> {
  const { content, fileName, filePath, fileType, language, monaco, renderedHtml, imageUrl } = opts

  const dirPath = filePath.includes('/') ? filePath.substring(0, filePath.lastIndexOf('/')) : '/'
  const date = new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })

  let bodyHtml = ''

  switch (fileType) {
    case 'code': {
      if (monaco) {
        const colorized = await monaco.editor.colorize(content, language || 'plaintext', { tabSize: 2 })
        bodyHtml = `<div class="code-content"><pre class="code-block">${colorized}</pre></div>`
      } else {
        bodyHtml = `<div class="code-content"><pre class="code-block">${escapeHtml(content)}</pre></div>`
      }
      break
    }
    case 'markdown': {
      bodyHtml = `<div class="markdown-content">${renderedHtml || escapeHtml(content)}</div>`
      break
    }
    case 'image': {
      bodyHtml = `<div class="image-content"><img src="${imageUrl}" alt="${escapeHtml(fileName)}" /></div>`
      break
    }
    default: {
      bodyHtml = `<div class="code-content"><pre class="code-block">${escapeHtml(content)}</pre></div>`
      break
    }
  }

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>${escapeHtml(fileName)}</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }

  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    color: #1a1a1a;
    background: #fff;
    padding: 40px;
    line-height: 1.6;
  }

  .print-header {
    border-bottom: 2px solid #e0e0e0;
    padding-bottom: 12px;
    margin-bottom: 24px;
  }

  .print-header h1 {
    font-size: 20px;
    font-weight: 600;
    margin-bottom: 4px;
  }

  .print-header .meta {
    font-size: 13px;
    color: #666;
  }

  /* Code styles */
  .code-content pre.code-block {
    font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', Consolas, monospace;
    font-size: 12px;
    line-height: 1.5;
    counter-reset: line;
    white-space: pre-wrap;
    word-wrap: break-word;
  }

  /* Line numbers via Monaco's <br> separated lines */
  .code-content pre.code-block > div,
  .code-content pre.code-block > span {
    display: block;
    counter-increment: line;
    padding-left: 50px;
    position: relative;
    min-height: 1.5em;
  }

  .code-content pre.code-block > div::before,
  .code-content pre.code-block > span::before {
    content: counter(line);
    position: absolute;
    left: 0;
    width: 38px;
    text-align: right;
    color: #999;
    font-size: 11px;
    user-select: none;
    padding-right: 8px;
    border-right: 1px solid #e0e0e0;
    margin-right: 12px;
  }

  /* Markdown styles */
  .markdown-content {
    max-width: 800px;
  }

  .markdown-content h1 { font-size: 24px; margin: 20px 0 12px; border-bottom: 1px solid #e0e0e0; padding-bottom: 6px; }
  .markdown-content h2 { font-size: 20px; margin: 18px 0 10px; border-bottom: 1px solid #eee; padding-bottom: 4px; }
  .markdown-content h3 { font-size: 16px; margin: 16px 0 8px; }
  .markdown-content h4, .markdown-content h5, .markdown-content h6 { font-size: 14px; margin: 14px 0 6px; }
  .markdown-content p { margin: 8px 0; }
  .markdown-content ul, .markdown-content ol { margin: 8px 0; padding-left: 24px; }
  .markdown-content li { margin: 4px 0; }
  .markdown-content blockquote { border-left: 3px solid #ccc; padding-left: 12px; color: #555; margin: 8px 0; }

  .markdown-content pre {
    background: #f5f5f5;
    padding: 12px;
    border-radius: 4px;
    overflow-x: auto;
    margin: 8px 0;
    font-family: 'SF Mono', 'Fira Code', Consolas, monospace;
    font-size: 12px;
  }

  .markdown-content code {
    font-family: 'SF Mono', 'Fira Code', Consolas, monospace;
    font-size: 12px;
  }

  .markdown-content :not(pre) > code {
    background: #f0f0f0;
    padding: 1px 4px;
    border-radius: 3px;
  }

  .markdown-content table {
    border-collapse: collapse;
    margin: 12px 0;
    width: 100%;
  }

  .markdown-content th, .markdown-content td {
    border: 1px solid #ddd;
    padding: 6px 10px;
    text-align: left;
  }

  .markdown-content th { background: #f5f5f5; font-weight: 600; }
  .markdown-content img { max-width: 100%; }
  .markdown-content a { color: #0366d6; text-decoration: none; }
  .markdown-content hr { border: none; border-top: 1px solid #e0e0e0; margin: 16px 0; }

  /* Image styles */
  .image-content {
    text-align: center;
    padding: 20px 0;
  }

  .image-content img {
    max-width: 100%;
    max-height: 80vh;
  }

  /* Print-specific */
  @media print {
    body { padding: 20px; }
    .code-content pre.code-block { font-size: 10px; }
    .code-content pre.code-block > div,
    .code-content pre.code-block > span {
      break-inside: avoid;
    }
    .image-content img { max-height: 90vh; }
  }
</style>
</head>
<body>
  <div class="print-header">
    <h1>${escapeHtml(fileName)}</h1>
    <div class="meta">${escapeHtml(dirPath)} &middot; ${date}</div>
  </div>
  ${bodyHtml}
  <script>
    window.onload = function() {
      // Small delay to ensure styles and images are loaded
      setTimeout(function() { window.print(); }, 300);
    };
  </script>
</body>
</html>`

  const printWindow = window.open('', '_blank')
  if (!printWindow) {
    alert('Could not open print window. Please allow popups for this site.')
    return
  }
  printWindow.document.write(html)
  printWindow.document.close()
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
