#!/usr/bin/env node
// Stands in for `claude -p` in the tests: answers like the real one, without a model.
let input = ''
process.stdin.on('data', (d) => (input += d))
process.stdin.on('end', () => {
  const args = process.argv.slice(2)
  const schema = args.includes('--json-schema')
  if (!args.includes('--tools') || args[args.indexOf('--tools') + 1] !== '') {
    console.log(JSON.stringify({ type: 'result', subtype: 'error', is_error: true, result: 'tools were not switched off' }))
    return
  }
  const structured = schema
    ? {
        title: 'Budget review',
        kind: 'meeting',
        language: 'en',
        summary: 'The team agreed the budget.',
        participants: [{ speaker_label: 'Speaker 1', name: 'Ana', role: 'chair' }],
        write_up: '## Budget\n- Agreed at **40k**',
        action_items: [{ owner: 'Ana', is_mine: false, task: 'Send the sheet', due: '2026-01-09', timestamp: '[00:05]' }],
        decisions: [{ text: 'Budget agreed', timestamp: null }],
        key_points: [],
        dates: [],
        quotes: [],
        ideas: [],
        follow_ups: [],
        open_questions: ['Who signs?'],
      }
    : undefined
  const sawTranscript = input.includes('<transcript>') && input.includes('We agree on the budget')
  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: schema ? '' : `Answer (saw transcript: ${sawTranscript})`, structured_output: structured, total_cost_usd: 0.01, modelUsage: { 'fake-model': {} } }))
})
