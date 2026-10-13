// Session events shaped as dsh 0.2.0-rc.2 (session format V4) writes them.
//
//   user/message   data IS the message               @deepseek-ai/dsh-session: surface fold
//                                                    (`case "user/message": return event.data`)
//   tool/call      data { turn, step, callId, name, arguments }
//                                                    @deepseek-ai/dsh-agent-loop: appendToolCall
//   tool/result    data.message is a tool-role message { id, role:'tool', toolCallId, isError,
//                  source:{kind:'tool', callId}, content:[{type:'text', text}] }
//                                                    dsh-agent-loop appendToolResult ->
//                                                    dsh-llm createToolResultMessage
//   assistant      data.message.content holds { type:'tool-call', id, name, arguments: '<json>' }
//                                                    dsh-llm ToolCallBlock

let n = 0
const id = () => `m${++n}`

export function userMessage(text, source = { kind: 'user' }) {
  return { type: 'user/message', data: { id: id(), role: 'user', content: [{ type: 'text', text }], source } }
}

export function assistantToolCall(callId, name, args) {
  return {
    type: 'assistant/message',
    data: {
      turn: 1,
      step: 1,
      message: {
        id: id(),
        role: 'assistant',
        content: [{ type: 'tool-call', id: callId, name, arguments: JSON.stringify(args) }],
        source: { kind: 'model', provider: 'p', model: 'm' },
      },
    },
  }
}

export function toolCall(callId, name, args) {
  return { type: 'tool/call', data: { turn: 1, step: 1, callId, name, arguments: JSON.stringify(args) } }
}

export function toolResult(callId, text, { isError = false, content } = {}) {
  return {
    type: 'tool/result',
    data: {
      turn: 1,
      step: 1,
      message: {
        id: id(),
        role: 'tool',
        toolCallId: callId,
        isError,
        source: { kind: 'tool', callId },
        content: content ?? [{ type: 'text', text }],
      },
    },
  }
}

/** One full call round: the assistant's request, the durable call record, the result. */
export function round(callId, name, args, resultText, options) {
  return [assistantToolCall(callId, name, args), toolCall(callId, name, args), toolResult(callId, resultText, options)]
}
