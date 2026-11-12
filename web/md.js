/**
 * A small, safe Markdown renderer for Claude's notes and answers: everything
 * is escaped first, then only these shapes become HTML. Links only for
 * http(s). No raw HTML ever passes through.
 */

export function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** [12:04] / [1:02:03] become buttons that play from there (the page handles data-at). */
export function stampButtons(html) {
  return html.replace(/\[(\d{1,2}:\d{2}(?::\d{2})?)\]|`(\d{1,2}:\d{2}(?::\d{2})?)`/g, (_, a, b) => `<button type="button" class="ts" data-at="${a ?? b}">${a ?? b}</button>`)
}

export function inline(s) {
  let h = esc(s)
  h = h.replace(/`([^`]+)`/g, (m, c) => (/^\d{1,2}:\d{2}(:\d{2})?$/.test(c) ? m : `<code>${c}</code>`))
  h = h.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  h = h.replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?!\w)/g, '$1<em>$2</em>')
  h = h.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, t, u) => `<a href="${u}" target="_blank" rel="noopener noreferrer">${t}</a>`)
  return stampButtons(h)
}

export function md(text) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n')
  const out = []
  let list = null // 'ul' | 'ol'
  let para = []
  let quote = []
  const flushPara = () => {
    if (para.length) out.push(`<p>${para.map(inline).join('<br>')}</p>`)
    para = []
  }
  const flushList = () => {
    if (list) out.push(`</${list}>`)
    list = null
  }
  const flushQuote = () => {
    if (quote.length) out.push(`<blockquote>${quote.map(inline).join('<br>')}</blockquote>`)
    quote = []
  }
  const flush = () => (flushPara(), flushList(), flushQuote())
  for (const raw of lines) {
    const line = raw.trimEnd()
    let m
    if (!line.trim()) {
      flush()
    } else if ((m = /^(#{1,6})\s+(.*)$/.exec(line))) {
      flush()
      const n = Math.min(4, m[1].length + 1) // a note's "#" sits under the page's own heading
      out.push(`<h${n}>${inline(m[2])}</h${n}>`)
    } else if ((m = /^\s*[-*+]\s+(?:\[( |x)\]\s+)?(.*)$/i.exec(line))) {
      flushPara()
      flushQuote()
      if (list !== 'ul') (flushList(), out.push('<ul>'), (list = 'ul'))
      out.push(`<li>${m[1] !== undefined ? (m[1].toLowerCase() === 'x' ? '☑ ' : '☐ ') : ''}${inline(m[2])}</li>`)
    } else if ((m = /^\s*\d+[.)]\s+(.*)$/.exec(line))) {
      flushPara()
      flushQuote()
      if (list !== 'ol') (flushList(), out.push('<ol>'), (list = 'ol'))
      out.push(`<li>${inline(m[1])}</li>`)
    } else if ((m = /^>\s?(.*)$/.exec(line))) {
      flushPara()
      flushList()
      quote.push(m[1])
    } else if (/^(-{3,}|\*{3,})$/.test(line.trim())) {
      flush()
      out.push('<hr>')
    } else {
      flushList()
      flushQuote()
      para.push(line.trim())
    }
  }
  flush()
  return out.join('\n')
}
