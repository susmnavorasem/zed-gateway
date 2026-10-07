// Request/response format converters: OpenAI Chat ↔ Zed provider formats.

const PROVIDER_MAP = {
  'claude-sonnet-5': 'anthropic',
  'claude-sonnet-4-6': 'anthropic',
  'claude-sonnet-4-5': 'anthropic',
  'claude-haiku-4-5': 'anthropic',
  'gpt-5.6-sol': 'open_ai',
  'gpt-5.6-terra': 'open_ai',
  'gpt-5.6-luna': 'open_ai',
  'gpt-5.5': 'open_ai',
  'gpt-5.4': 'open_ai',
  'gpt-5.3-codex': 'open_ai',
  'gpt-5.2': 'open_ai',
  'gpt-5-mini': 'open_ai',
  'gpt-5-nano': 'open_ai',
  'gemini-3.1-pro-preview': 'google',
  'gemini-3.5-flash': 'google',
  'gemini-3-flash': 'google',
}

export const ALL_MODELS = Object.keys(PROVIDER_MAP)

export function detectProvider(model) {
  if (PROVIDER_MAP[model]) return PROVIDER_MAP[model]
  if (model.startsWith('claude-')) return 'anthropic'
  if (model.startsWith('gpt-')) return 'open_ai'
  if (model.startsWith('gemini-')) return 'google'
  return 'anthropic' // fallback
}

// ── OpenAI Chat messages → Anthropic Messages API ───────────────────────────

function convertToAnthropic(parsed) {
  const messages = parsed.messages || []
  let systemText = ''
  const converted = []

  for (const msg of messages) {
    if (msg.role === 'system') {
      // Accumulate system messages
      const text = typeof msg.content === 'string' ? msg.content
        : Array.isArray(msg.content) ? msg.content.map(p => typeof p === 'string' ? p : p.text || '').join('\n')
        : ''
      systemText += (systemText ? '\n' : '') + text
      continue
    }

    // Convert content format
    let content = msg.content
    if (msg.role === 'tool') {
      // Tool result message → Anthropic tool_result block
      converted.push({
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: msg.tool_call_id,
          content: typeof content === 'string' ? content : JSON.stringify(content),
        }],
      })
      continue
    }

    if (msg.role === 'assistant' && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
      // Assistant message with tool calls → Anthropic content blocks
      const blocks = []
      if (content && typeof content === 'string' && content.trim()) {
        blocks.push({ type: 'text', text: content })
      }
      for (const tc of msg.tool_calls) {
        blocks.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.function?.name,
          input: typeof tc.function?.arguments === 'string'
            ? JSON.parse(tc.function.arguments)
            : tc.function?.arguments || {},
        })
      }
      converted.push({ role: 'assistant', content: blocks })
      continue
    }

    if (msg.role === 'user' && Array.isArray(content)) {
      content = content.map(p => {
        if (typeof p === 'string') return { type: 'text', text: p };
        if (p.type === 'text') return { type: 'text', text: p.text };
        if (p.type === 'image_url' && p.image_url?.url?.startsWith('data:image/')) {
          const [mime, data] = p.image_url.url.split(';base64,');
          return { type: 'image', source: { type: 'base64', media_type: mime.replace('data:', ''), data } };
        }
        return p;
      });
    }
    converted.push({ role: msg.role, content })
  }

  const providerRequest = {
    model: parsed.model,
    max_tokens: parsed.max_tokens || parsed.max_completion_tokens || 8192,
    messages: converted,
  }

  if (systemText) {
    providerRequest.system = systemText
  }

  // Pass through tools if present
  if (Array.isArray(parsed.tools) && parsed.tools.length > 0) {
    providerRequest.tools = parsed.tools.map(t => ({
      name: t.function?.name || t.name,
      description: t.function?.description || t.description || '',
      input_schema: t.function?.parameters || t.parameters || { type: 'object', properties: {} },
    }))
  }

  if (parsed.tool_choice) {
    if (parsed.tool_choice === 'auto') {
      providerRequest.tool_choice = { type: 'auto' }
    } else if (parsed.tool_choice === 'none') {
      providerRequest.tool_choice = { type: 'none' }
    } else if (parsed.tool_choice === 'required') {
      providerRequest.tool_choice = { type: 'any' }
    } else if (typeof parsed.tool_choice === 'object' && parsed.tool_choice.function?.name) {
      providerRequest.tool_choice = { type: 'tool', name: parsed.tool_choice.function.name }
    }
  }

  if (parsed.temperature !== undefined) providerRequest.temperature = parsed.temperature
  if (parsed.top_p !== undefined) providerRequest.top_p = parsed.top_p

  return providerRequest
}

// ── OpenAI Chat messages → OpenAI Responses API ─────────────────────────────

function convertToOpenAIResponses(parsed) {
  const messages = parsed.messages || []
  const input = []

  for (const msg of messages) {
    if (msg.role === 'system') {
      input.push({
        type: 'message',
        role: 'developer',
        content: [{ type: 'input_text', text: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content) }],
      })
      continue
    }

    if (msg.role === 'tool') {
      input.push({
        type: 'function_call_output',
        call_id: msg.tool_call_id,
        output: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
      })
      continue
    }

    if (msg.role === 'assistant') {
      const items = []
      if (msg.content && typeof msg.content === 'string' && msg.content.trim()) {
        items.push({
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: msg.content }],
        })
      }
      if (Array.isArray(msg.tool_calls)) {
        for (const tc of msg.tool_calls) {
          items.push({
            type: 'function_call',
            id: tc.id,
            call_id: tc.id,
            name: tc.function?.name,
            arguments: tc.function?.arguments || '{}',
          })
        }
      }
      if (items.length === 0 && msg.content) {
        items.push({
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content) }],
        })
      }
      input.push(...items)
      continue
    }

    // user messages
    const textContent = typeof msg.content === 'string' ? msg.content
      : Array.isArray(msg.content) ? msg.content.map(p => typeof p === 'string' ? p : p.text || '').join('\n')
      : JSON.stringify(msg.content)

    input.push({
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: textContent }],
    })
  }

  const providerRequest = {
    model: parsed.model,
    input,
    stream: true,
  }

  if (parsed.max_tokens || parsed.max_completion_tokens) {
    providerRequest.max_output_tokens = parsed.max_tokens || parsed.max_completion_tokens
  }
  if (parsed.temperature !== undefined) providerRequest.temperature = parsed.temperature
  if (parsed.top_p !== undefined) providerRequest.top_p = parsed.top_p

  // Tools → functions
  if (Array.isArray(parsed.tools) && parsed.tools.length > 0) {
    providerRequest.tools = parsed.tools.map(t => ({
      type: 'function',
      name: t.function?.name || t.name,
      description: t.function?.description || t.description || '',
      parameters: t.function?.parameters || t.parameters || { type: 'object', properties: {} },
    }))
  }

  return providerRequest
}

// ── OpenAI Chat messages → Gemini generateContent ───────────────────────────

function convertToGemini(parsed) {
  const messages = parsed.messages || []
  const contents = []
  let systemInstruction = null

  for (const msg of messages) {
    const textContent = typeof msg.content === 'string' ? msg.content
      : Array.isArray(msg.content) ? msg.content.map(p => typeof p === 'string' ? p : p.text || '').join('\n')
      : JSON.stringify(msg.content)

    if (msg.role === 'system') {
      systemInstruction = { parts: [{ text: textContent }] }
      continue
    }

    const role = msg.role === 'assistant' ? 'model' : 'user'

    if (msg.role === 'tool') {
      contents.push({
        role: 'function',
        parts: [{
          functionResponse: {
            name: msg.name || 'tool',
            response: { result: textContent },
          },
        }],
      })
      continue
    }

    if (msg.role === 'assistant' && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
      const parts = []
      if (textContent.trim()) parts.push({ text: textContent })
      for (const tc of msg.tool_calls) {
        parts.push({
          functionCall: {
            name: tc.function?.name,
            args: typeof tc.function?.arguments === 'string'
              ? JSON.parse(tc.function.arguments)
              : tc.function?.arguments || {},
          },
        })
      }
      contents.push({ role, parts })
      continue
    }

    contents.push({ role, parts })
  }

  const providerRequest = {
    model: parsed.model,
    contents,
    generationConfig: {
      maxOutputTokens: parsed.max_tokens || parsed.max_completion_tokens || 8192,
    },
  }

  if (systemInstruction) {
    providerRequest.systemInstruction = systemInstruction
  }

  if (parsed.temperature !== undefined) providerRequest.generationConfig.temperature = parsed.temperature
  if (parsed.top_p !== undefined) providerRequest.generationConfig.topP = parsed.top_p

  if (Array.isArray(parsed.tools) && parsed.tools.length > 0) {
    providerRequest.tools = [{
      functionDeclarations: parsed.tools.map(t => ({
        name: t.function?.name || t.name,
        description: t.function?.description || t.description || '',
        parameters: t.function?.parameters || t.parameters || {},
      })),
    }]
  }

  return providerRequest
}

// ── Main converter ──────────────────────────────────────────────────────────

export function convertToZedRequest(openaiBody, model) {
  const parsed = typeof openaiBody === 'string' ? JSON.parse(openaiBody) : openaiBody
  parsed.model = model
  const provider = detectProvider(model)

  let providerRequest
  switch (provider) {
    case 'anthropic':
      providerRequest = convertToAnthropic(parsed)
      break
    case 'open_ai':
      providerRequest = convertToOpenAIResponses(parsed)
      break
    case 'google':
      providerRequest = convertToGemini(parsed)
      break
    default:
      providerRequest = convertToAnthropic(parsed)
  }

  return {
    provider,
    model,
    provider_request: providerRequest,
  }
}

// ── NDJSON event delta extractors ───────────────────────────────────────────

export function extractAnthropicDelta(event) {
  if (!event || typeof event !== 'object') return null

  switch (event.type) {
    case 'message_start':
      return { type: 'role', role: 'assistant' }

    case 'content_block_start': {
      const block = event.content_block
      if (block?.type === 'tool_use') {
        return {
          type: 'tool_call_start',
          index: event.index ?? 0,
          id: block.id,
          name: block.name,
        }
      }
      return null
    }

    case 'content_block_delta': {
      const delta = event.delta
      if (delta?.type === 'text_delta') {
        return { type: 'text', text: delta.text }
      }
      if (delta?.type === 'input_json_delta') {
        return {
          type: 'tool_call_delta',
          index: event.index ?? 0,
          arguments: delta.partial_json,
        }
      }
      if (delta?.type === 'thinking_delta') {
        return { type: 'reasoning', text: delta.thinking }
      }
      return null
    }

    case 'message_delta': {
      const stopReason = event.delta?.stop_reason
      if (stopReason === 'end_turn' || stopReason === 'stop') {
        return { type: 'finish', reason: 'stop' }
      }
      if (stopReason === 'tool_use') {
        return { type: 'finish', reason: 'tool_calls' }
      }
      if (stopReason === 'max_tokens') {
        return { type: 'finish', reason: 'length' }
      }
      if (stopReason) {
        return { type: 'finish', reason: stopReason }
      }
      return null
    }

    case 'message_stop':
      return { type: 'stop' }

    default:
      return null
  }
}

export function extractOpenAIDelta(event) {
  if (!event || typeof event !== 'object') return null

  switch (event.type) {
    case 'response.output_item.added': {
      const item = event.item
      if (item?.type === 'message') {
        return { type: 'role', role: 'assistant' }
      }
      if (item?.type === 'function_call') {
        return {
          type: 'tool_call_start',
          index: event.output_index ?? 0,
          id: item.call_id || item.id,
          name: item.name,
        }
      }
      return null
    }

    case 'response.output_text.delta':
      return { type: 'text', text: event.delta || '' }

    case 'response.function_call_arguments.delta':
      return {
        type: 'tool_call_delta',
        index: event.output_index ?? 0,
        arguments: event.delta || '',
      }

    case 'response.completed':
      return { type: 'finish', reason: 'stop' }

    case 'response.output_item.done': {
      const item = event.item
      if (item?.type === 'function_call') {
        return { type: 'tool_call_done', index: event.output_index ?? 0 }
      }
      return null
    }

    default:
      return null
  }
}

export function extractGeminiDelta(event) {
  if (!event || typeof event !== 'object') return null

  // Gemini streaming returns candidates
  const candidates = event.candidates
  if (Array.isArray(candidates) && candidates.length > 0) {
    const candidate = candidates[0]
    const parts = candidate?.content?.parts
    if (Array.isArray(parts)) {
      for (const part of parts) {
        if (typeof part.text === 'string') {
          return { type: 'text', text: part.text }
        }
        if (part.functionCall) {
          return {
            type: 'tool_call_full',
            name: part.functionCall.name,
            arguments: JSON.stringify(part.functionCall.args || {}),
          }
        }
      }
    }
    const finishReason = candidate?.finishReason
    if (finishReason === 'STOP') {
      return { type: 'finish', reason: 'stop' }
    }
    if (finishReason === 'MAX_TOKENS') {
      return { type: 'finish', reason: 'length' }
    }
    if (finishReason) {
      return { type: 'finish', reason: finishReason.toLowerCase() }
    }
  }

  return null
}

export function extractDelta(providerEvent, provider) {
  switch (provider) {
    case 'anthropic': return extractAnthropicDelta(providerEvent)
    case 'open_ai': return extractOpenAIDelta(providerEvent)
    case 'google': return extractGeminiDelta(providerEvent)
    default: return extractAnthropicDelta(providerEvent)
  }
}