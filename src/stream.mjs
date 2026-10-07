// NDJSON → OpenAI SSE stream transformer and non-stream buffer.

import { detectProvider, extractDelta } from './converter.mjs'

function generateId() {
  return 'chatcmpl-zed-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}

function writeSse(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`)
}

// ── Streaming transformer ───────────────────────────────────────────────────

export function createNdjsonToSseTransformer(res, model, log) {
  const provider = detectProvider(model)
  const chatId = generateId()
  const created = Math.floor(Date.now() / 1000)
  let roleSent = false
  let finishSent = false
  let toolCallIndex = -1

  function emitRole() {
    if (roleSent) return
    roleSent = true
    writeSse(res, {
      id: chatId,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
    })
  }

  function emitText(text) {
    emitRole()
    writeSse(res, {
      id: chatId,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
    })
  }

  function emitReasoning(text) {
    emitRole()
    writeSse(res, {
      id: chatId,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta: { reasoning_content: text }, finish_reason: null }],
    })
  }

  function emitToolCallStart(id, name, index) {
    emitRole()
    const tcIndex = index !== undefined ? index : ++toolCallIndex
    if (tcIndex > toolCallIndex) toolCallIndex = tcIndex
    writeSse(res, {
      id: chatId,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{
        index: 0,
        delta: {
          tool_calls: [{
            index: tcIndex,
            id,
            type: 'function',
            function: { name, arguments: '' },
          }],
        },
        finish_reason: null,
      }],
    })
  }

  function emitToolCallDelta(index, args) {
    emitRole()
    writeSse(res, {
      id: chatId,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{
        index: 0,
        delta: {
          tool_calls: [{
            index,
            function: { arguments: args },
          }],
        },
        finish_reason: null,
      }],
    })
  }

  function emitToolCallFull(name, args) {
    emitRole()
    toolCallIndex++
    writeSse(res, {
      id: chatId,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{
        index: 0,
        delta: {
          tool_calls: [{
            index: toolCallIndex,
            id: `call_${chatId}_${toolCallIndex}`,
            type: 'function',
            function: { name, arguments: args },
          }],
        },
        finish_reason: null,
      }],
    })
  }

  function emitFinish(reason) {
    if (finishSent) return
    finishSent = true
    emitRole() // ensure role was sent
    writeSse(res, {
      id: chatId,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta: {}, finish_reason: reason || 'stop' }],
    })
  }

  function processLine(line) {
    if (!line || !line.trim()) return

    let parsed
    try {
      parsed = JSON.parse(line)
    } catch {
      log('debug', `[stream] unparseable NDJSON line: ${line.slice(0, 200)}`)
      return
    }

    if (parsed.type === 'status') {
      // started / stream_ended — nothing to emit
      return
    }

    if (parsed.type === 'event') {
      const event = parsed.event
      const delta = extractDelta(event, provider)
      if (!delta) return

      switch (delta.type) {
        case 'role':
          emitRole()
          break
        case 'text':
          emitText(delta.text)
          break
        case 'reasoning':
          emitReasoning(delta.text)
          break
        case 'tool_call_start':
          emitToolCallStart(delta.id, delta.name, delta.index)
          break
        case 'tool_call_delta':
          emitToolCallDelta(delta.index, delta.arguments)
          break
        case 'tool_call_full':
          emitToolCallFull(delta.name, delta.arguments)
          break
        case 'tool_call_done':
          // no-op, finish handles it
          break
        case 'finish':
          emitFinish(delta.reason)
          break
        case 'stop':
          // message_stop — ensure finish was sent
          if (!finishSent) emitFinish('stop')
          break
      }
      return
    }

    // Unknown top-level type — skip
    log('debug', `[stream] unknown NDJSON type: ${parsed.type}`)
  }

  function finish() {
    if (!finishSent) emitFinish('stop')
    res.write('data: [DONE]\n\n')
  }

  return { processLine, finish, chatId }
}

// ── Non-streaming buffer ────────────────────────────────────────────────────

export function bufferNdjsonResponse(bodyText, model) {
  const provider = detectProvider(model)
  const lines = bodyText.split('\n').filter(l => l.trim())
  let contentParts = []
  let finishReason = 'stop'
  let toolCalls = []
  let toolCallIndex = -1
  let reasoningContent = ''

  for (const line of lines) {
    let parsed
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }

    if (parsed.type !== 'event') continue

    const delta = extractDelta(parsed.event, provider)
    if (!delta) continue

    switch (delta.type) {
      case 'text':
        contentParts.push(delta.text)
        break
      case 'reasoning':
        reasoningContent += delta.text
        break
      case 'tool_call_start':
        toolCallIndex++
        toolCalls.push({
          id: delta.id || `call_${Date.now()}_${toolCallIndex}`,
          type: 'function',
          function: { name: delta.name, arguments: '' },
        })
        break
      case 'tool_call_delta':
        if (toolCalls[delta.index]) {
          toolCalls[delta.index].function.arguments += delta.arguments
        }
        break
      case 'tool_call_full':
        toolCallIndex++
        toolCalls.push({
          id: `call_${Date.now()}_${toolCallIndex}`,
          type: 'function',
          function: { name: delta.name, arguments: delta.arguments },
        })
        break
      case 'finish':
        finishReason = delta.reason || 'stop'
        break
    }
  }

  const message = {
    role: 'assistant',
    content: contentParts.join('') || null,
  }

  if (reasoningContent) {
    message.reasoning_content = reasoningContent
  }

  if (toolCalls.length > 0) {
    message.tool_calls = toolCalls
  }

  return {
    id: generateId(),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      message,
      finish_reason: finishReason,
    }],
    usage: null,
  }
}
