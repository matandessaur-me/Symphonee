/**
 * Apps Agent Chat - Live Providers
 *
 * Parallel to apps-agent-chat.js's request/response tool loop. These runners
 * keep a bidirectional socket open while a capture pump streams JPEG frames
 * to a vision model that can emit tool calls asynchronously. That is the
 * "screenshare to a vision AI" feel - the model always has current pixels
 * and doesn't have to stop to re-ask for a screenshot between actions.
 *
 * Providers:
 *   - gemini-live:      Gemini Live API (bidiGenerateContent WebSocket)
 *   - openai-realtime:  OpenAI Realtime API (stub - image-over-WS event
 *                       shape not yet verified against a working reference)
 */

const WebSocket = require('ws');
const { DESKTOP_TOOLS, BASE_SYSTEM_PROMPT, executeTool } = require('./apps-agent-chat');

const GEMINI_LIVE_ENDPOINT = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';
const DEFAULT_GEMINI_LIVE_MODEL = 'gemini-3.1-flash-live-preview';
const DEFAULT_OPENAI_REALTIME_MODEL = 'gpt-realtime';
const DEFAULT_FRAME_INTERVAL_MS = 500;
const DEFAULT_FRAME_QUALITY = 45;

const LIVE_SYSTEM_PROMPT = BASE_SYSTEM_PROMPT + '\n\n## LIVE STREAMING MODE\n' +
  'You are receiving a continuous JPEG video feed of the target window. The latest ' +
  'frames are always visible to you - you do NOT need to call screenshot. Act when ' +
  'the window is ready for your next step; if nothing is happening, briefly wait ' +
  'rather than spamming tool calls. When the overall goal is complete, call finish ' +
  'with a short summary.';

// Gemini function declarations: drop screenshot (frames auto-stream) and
// wait_ms (the stream already paces the model). Everything else stays.
function buildGeminiFunctionDeclarations() {
  return DESKTOP_TOOLS
    .filter(t => t.name !== 'screenshot')
    .map(t => ({ name: t.name, description: t.description, parameters: t.parameters }));
}

function summarizeLiveResult(name, result) {
  if (result == null) return 'ok';
  if (typeof result === 'string') return result.slice(0, 120);
  try { return JSON.stringify(result).slice(0, 180); } catch (_) { return 'ok'; }
}

async function runGeminiLive({ session, task, driver, providerEntry, model, broadcast }) {
  const apiKey = providerEntry && providerEntry.apiKey;
  if (!apiKey) {
    if (typeof broadcast === 'function') {
      broadcast({ type: 'apps-agent-step', sessionId: session.id, kind: 'error', message: 'GEMINI_API_KEY missing - set it in Settings -> AI Keys.', at: Date.now() });
    }
    session.running = false;
    return { ok: false, error: 'missing_gemini_api_key' };
  }
  const chosenModel = model || DEFAULT_GEMINI_LIVE_MODEL;
  const modelRef = chosenModel.startsWith('models/') ? chosenModel : `models/${chosenModel}`;
  const url = `${GEMINI_LIVE_ENDPOINT}?key=${encodeURIComponent(apiKey)}`;
  const emit = (step) => {
    if (typeof broadcast === 'function') {
      broadcast({ type: 'apps-agent-step', sessionId: session.id, ...step, at: Date.now() });
    }
  };
  session._emit = emit;
  session._providerEntry = providerEntry;
  session._model = chosenModel;
  session.running = true;
  session.messages = session.messages || [];

  emit({ kind: 'provider', provider: 'gemini-live', label: 'Gemini Live', streaming: true });

  return await new Promise((resolve) => {
    let pump = null;
    let done = false;
    const ws = new WebSocket(url);
    session._liveWs = ws;

    const cleanup = () => {
      try { pump && pump.stop(); } catch (_) {}
      pump = null;
      try { if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close(); } catch (_) {}
      session._liveWs = null;
      session._liveStop = null;
      session.running = false;
    };

    const finish = (res) => {
      if (done) return;
      done = true;
      cleanup();
      resolve(res);
    };

    session._liveStop = () => finish({ ok: true, summary: 'Stopped by user.' });

    const send = (obj) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      try { ws.send(JSON.stringify(obj)); } catch (_) {}
    };

    ws.on('open', () => {
      emit({ kind: 'live_connected' });
      send({
        setup: {
          model: modelRef,
          generationConfig: { responseModalities: ['TEXT'] },
          systemInstruction: { parts: [{ text: LIVE_SYSTEM_PROMPT }] },
          tools: [{ functionDeclarations: buildGeminiFunctionDeclarations() }],
        },
      });
    });

    ws.on('message', async (raw) => {
      if (done) return;
      let msg;
      try { msg = JSON.parse(raw.toString('utf8')); } catch (_) { return; }

      if (msg.setupComplete !== undefined) {
        emit({ kind: 'live_setup_complete' });
        pump = driver.startCapturePump(session.hwnd, (shot) => {
          if (done || !shot || !shot.base64) return;
          if (ws.readyState !== WebSocket.OPEN) return;
          send({
            realtimeInput: {
              mediaChunks: [{ mimeType: shot.mimeType || 'image/jpeg', data: shot.base64 }],
            },
          });
          emit({
            kind: 'screenshot',
            base64: shot.base64,
            mimeType: shot.mimeType || 'image/jpeg',
            width: shot.width,
            height: shot.height,
            rect: shot.rect,
            streaming: true,
          });
        }, { intervalMs: DEFAULT_FRAME_INTERVAL_MS, quality: DEFAULT_FRAME_QUALITY });
        // First user turn: the goal text.
        send({ clientContent: { turns: [{ role: 'user', parts: [{ text: task }] }], turnComplete: true } });
        return;
      }

      if (msg.serverContent) {
        const parts = msg.serverContent.modelTurn && msg.serverContent.modelTurn.parts;
        if (Array.isArray(parts)) {
          for (const p of parts) {
            if (p && p.text) emit({ kind: 'assistant_text', text: p.text });
          }
        }
        if (msg.serverContent.turnComplete) emit({ kind: 'turn_complete' });
        return;
      }

      if (msg.toolCall) {
        const calls = Array.isArray(msg.toolCall.functionCalls) ? msg.toolCall.functionCalls : [];
        const responses = [];
        for (const fc of calls) {
          const id = fc.id || `${fc.name}-${Date.now()}`;
          const name = fc.name;
          const args = fc.args || {};
          emit({ kind: 'tool_call', name, args, id });
          try {
            if (name === 'finish') {
              responses.push({ id, name, response: { result: 'ok' } });
              send({ toolResponse: { functionResponses: responses } });
              emit({ kind: 'done', summary: args.summary || 'Done.' });
              finish({ ok: true, summary: args.summary || 'Done.' });
              return;
            }
            if (name === 'declare_stuck') {
              responses.push({ id, name, response: { result: 'acknowledged' } });
              send({ toolResponse: { functionResponses: responses } });
              emit({ kind: 'stuck', reason: args.reason || 'stuck' });
              finish({ ok: false, error: args.reason || 'stuck' });
              return;
            }
            const result = await executeTool(driver, session, name, args);
            const payload = (result && typeof result === 'object') ? result : { value: result };
            responses.push({ id, name, response: payload });
            emit({ kind: 'tool_result', name, summary: summarizeLiveResult(name, result) });
          } catch (e) {
            responses.push({ id, name, response: { error: e.message } });
            emit({ kind: 'tool_error', name, error: e.message });
          }
        }
        if (responses.length && ws.readyState === WebSocket.OPEN) {
          send({ toolResponse: { functionResponses: responses } });
        }
        return;
      }

      if (msg.toolCallCancellation) {
        emit({ kind: 'tool_cancellation', ids: msg.toolCallCancellation.ids || [] });
        return;
      }

      if (msg.goAway) {
        emit({ kind: 'live_goaway', timeLeft: msg.goAway.timeLeft });
        return;
      }
    });

    ws.on('error', (err) => {
      emit({ kind: 'error', message: 'Live WS error: ' + (err && err.message || String(err)) });
      finish({ ok: false, error: err && err.message || String(err) });
    });

    ws.on('close', (code, reason) => {
      const r = reason && reason.toString ? reason.toString() : String(reason || '');
      emit({ kind: 'live_closed', code, reason: r });
      finish({ ok: true, summary: `Session closed (code=${code}).` });
    });
  });
}

// OpenAI Realtime note: the WebSocket transport accepts images only as
// discrete `input_image` conversation items, not as a continuous video track
// (true video streaming needs WebRTC, which is a much bigger build). So this
// runner opens a persistent socket, pushes one fresh frame per turn alongside
// tool results, and calls response.create to get the model's next move. That
// is faster than a stateless chat.completions loop (no per-request handshake)
// and the socket supports streaming tokens, but it is not the continuous
// video feel that Gemini Live gives you.
const OPENAI_REALTIME_ENDPOINT = 'wss://api.openai.com/v1/realtime';

function buildOpenAIRealtimeTools() {
  return DESKTOP_TOOLS
    .filter(t => t.name !== 'screenshot')
    .map(t => ({ type: 'function', name: t.name, description: t.description, parameters: t.parameters }));
}

async function runOpenAIRealtime({ session, task, driver, providerEntry, model, broadcast }) {
  const apiKey = providerEntry && providerEntry.apiKey;
  const emit = (step) => {
    if (typeof broadcast === 'function') {
      broadcast({ type: 'apps-agent-step', sessionId: session.id, ...step, at: Date.now() });
    }
  };
  if (!apiKey) {
    emit({ kind: 'error', message: 'OPENAI_API_KEY missing - set it in Settings -> AI Keys.' });
    session.running = false;
    return { ok: false, error: 'missing_openai_api_key' };
  }

  const chosenModel = model || DEFAULT_OPENAI_REALTIME_MODEL;
  const url = `${OPENAI_REALTIME_ENDPOINT}?model=${encodeURIComponent(chosenModel)}`;

  session._emit = emit;
  session._providerEntry = providerEntry;
  session._model = chosenModel;
  session.running = true;
  session.messages = session.messages || [];

  emit({ kind: 'provider', provider: 'openai-realtime', label: 'OpenAI Realtime', streaming: true });

  return await new Promise((resolve) => {
    let pump = null;
    let done = false;
    let latestFrame = null;
    let awaitingResponse = false;
    let pendingCall = null; // { call_id, name, argsText }

    const ws = new WebSocket(url, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'OpenAI-Beta': 'realtime=v1',
      },
    });
    session._liveWs = ws;

    const cleanup = () => {
      try { pump && pump.stop(); } catch (_) {}
      pump = null;
      try { if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close(); } catch (_) {}
      session._liveWs = null;
      session._liveStop = null;
      session.running = false;
    };
    const finish = (res) => {
      if (done) return;
      done = true;
      cleanup();
      resolve(res);
    };
    session._liveStop = () => finish({ ok: true, summary: 'Stopped by user.' });

    const send = (obj) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      try { ws.send(JSON.stringify(obj)); } catch (_) {}
    };

    const sendFrameItemAndRespond = () => {
      if (!latestFrame || awaitingResponse) return;
      send({
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: 'user',
          content: [{
            type: 'input_image',
            image_url: `data:${latestFrame.mimeType || 'image/jpeg'};base64,${latestFrame.base64}`,
          }],
        },
      });
      awaitingResponse = true;
      send({ type: 'response.create' });
    };

    ws.on('open', () => {
      emit({ kind: 'live_connected' });
      send({
        type: 'session.update',
        session: {
          modalities: ['text'],
          instructions: LIVE_SYSTEM_PROMPT,
          tools: buildOpenAIRealtimeTools(),
          tool_choice: 'auto',
        },
      });
      // Kick off the capture pump. We don't push every frame into the
      // conversation (that would explode token usage); the latest frame is
      // attached right before each response.create.
      pump = driver.startCapturePump(session.hwnd, (shot) => {
        if (done || !shot || !shot.base64) return;
        latestFrame = shot;
        emit({
          kind: 'screenshot',
          base64: shot.base64,
          mimeType: shot.mimeType || 'image/jpeg',
          width: shot.width,
          height: shot.height,
          rect: shot.rect,
          streaming: true,
        });
      }, { intervalMs: DEFAULT_FRAME_INTERVAL_MS, quality: DEFAULT_FRAME_QUALITY });

      // Send the goal as the initial user message and request a response
      // once we have at least one frame.
      const waitForFirstFrame = setInterval(() => {
        if (done) { clearInterval(waitForFirstFrame); return; }
        if (!latestFrame) return;
        clearInterval(waitForFirstFrame);
        send({
          type: 'conversation.item.create',
          item: {
            type: 'message',
            role: 'user',
            content: [
              { type: 'input_text', text: task },
              { type: 'input_image', image_url: `data:${latestFrame.mimeType || 'image/jpeg'};base64,${latestFrame.base64}` },
            ],
          },
        });
        awaitingResponse = true;
        send({ type: 'response.create' });
      }, 100);
    });

    ws.on('message', async (raw) => {
      if (done) return;
      let evt;
      try { evt = JSON.parse(raw.toString('utf8')); } catch (_) { return; }

      switch (evt.type) {
        case 'session.created':
        case 'session.updated':
          emit({ kind: 'live_setup_complete' });
          return;

        case 'response.text.delta':
          if (evt.delta) emit({ kind: 'assistant_text', text: evt.delta });
          return;

        case 'response.output_item.added':
          if (evt.item && evt.item.type === 'function_call') {
            pendingCall = { call_id: evt.item.call_id, name: evt.item.name, argsText: '' };
          }
          return;

        case 'response.function_call_arguments.delta':
          if (pendingCall && evt.call_id === pendingCall.call_id) {
            pendingCall.argsText += evt.delta || '';
          }
          return;

        case 'response.function_call_arguments.done': {
          if (!pendingCall || evt.call_id !== pendingCall.call_id) return;
          const name = pendingCall.name;
          let args = {};
          try { args = JSON.parse(pendingCall.argsText || '{}'); } catch (_) {}
          const callId = pendingCall.call_id;
          pendingCall = null;
          emit({ kind: 'tool_call', name, args, id: callId });

          if (name === 'finish') {
            emit({ kind: 'done', summary: args.summary || 'Done.' });
            finish({ ok: true, summary: args.summary || 'Done.' });
            return;
          }
          if (name === 'declare_stuck') {
            emit({ kind: 'stuck', reason: args.reason || 'stuck' });
            finish({ ok: false, error: args.reason || 'stuck' });
            return;
          }

          try {
            const result = await executeTool(driver, session, name, args);
            emit({ kind: 'tool_result', name, summary: summarizeLiveResult(name, result) });
            send({
              type: 'conversation.item.create',
              item: {
                type: 'function_call_output',
                call_id: callId,
                output: JSON.stringify(result == null ? { ok: true } : (typeof result === 'object' ? result : { value: result })),
              },
            });
          } catch (e) {
            emit({ kind: 'tool_error', name, error: e.message });
            send({
              type: 'conversation.item.create',
              item: { type: 'function_call_output', call_id: callId, output: JSON.stringify({ error: e.message }) },
            });
          }
          return;
        }

        case 'response.done':
          awaitingResponse = false;
          // If the model emitted tool calls, we've already posted their
          // outputs. Immediately attach the freshest frame and ask for the
          // next response so it can react visually.
          if (!done) {
            setTimeout(() => sendFrameItemAndRespond(), 50);
          }
          return;

        case 'error':
          emit({ kind: 'error', message: (evt.error && (evt.error.message || evt.error.code)) || 'realtime error' });
          return;

        default:
          return;
      }
    });

    ws.on('error', (err) => {
      emit({ kind: 'error', message: 'Live WS error: ' + (err && err.message || String(err)) });
      finish({ ok: false, error: err && err.message || String(err) });
    });
    ws.on('close', (code, reason) => {
      const r = reason && reason.toString ? reason.toString() : String(reason || '');
      emit({ kind: 'live_closed', code, reason: r });
      finish({ ok: true, summary: `Session closed (code=${code}).` });
    });
  });
}

module.exports = {
  runGeminiLive,
  runOpenAIRealtime,
  DEFAULT_GEMINI_LIVE_MODEL,
  DEFAULT_OPENAI_REALTIME_MODEL,
  DEFAULT_FRAME_INTERVAL_MS,
};
