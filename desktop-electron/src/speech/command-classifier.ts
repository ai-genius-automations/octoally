/**
 * GPT-5 mini voice command classifier.
 * Sends transcribed text + available commands to GPT-5 mini for intent classification.
 * Much more robust than regex matching for short/garbled utterances.
 */

import * as https from 'https';

export interface ClassifiedCommand {
  commandId: string;
  param: string;
}

interface CommandInfo {
  id: string;
  name: string;
  actionKind: string;
  actionTarget?: string;
}

/**
 * Classify a transcribed voice command using GPT-5 mini.
 * Returns the matched command ID and extracted parameter, or null if no match.
 */
export function classifyCommand(
  text: string,
  apiKey: string,
  commands: CommandInfo[],
): Promise<ClassifiedCommand | null> {
  const commandList = commands
    .map((c) => `  "${c.id}": ${c.name}`)
    .join('\n');

  const systemPrompt = `You are a voice command classifier for a terminal application.

COMMANDS:
${commandList}

OUTPUT FORMAT: {"commandId": "...", "param": "..."}

PARAM EXTRACTION IS CRITICAL:
The "param" field must contain everything the user said AFTER the command intent.

For navigate-terminal and navigate-hivemind: the user ALWAYS specifies a number. You MUST extract it and return it as a digit in "param". If they say a number word, convert it: one→1, two→2, three→3, four→4, five→5, six→6, seven→7, eight→8, nine→9, ten→10. The param for these commands is NEVER empty — it is always a number.

For navigate-project: the param is the project name (text after the command words).
For delete-words: the param is always a NUMBER (digit). Convert number words to digits: one→1, two→2, three→3, etc. If user says "delete words" with no number, default param to "1".

EXAMPLES:
User: "open terminal one" → {"commandId": "navigate-terminal", "param": "1"}
User: "open hivemind one" → {"commandId": "navigate-hivemind", "param": "1"}
User: "open hivemind 2" → {"commandId": "navigate-hivemind", "param": "2"}
User: "go to terminal three" → {"commandId": "navigate-terminal", "param": "3"}
User: "open project my cool app" → {"commandId": "navigate-project", "param": "my cool app"}
User: "open project samsung" → {"commandId": "navigate-project", "param": "samsung"}
User: "switch to hivemind two" → {"commandId": "navigate-hivemind", "param": "2"}
User: "stop" → {"commandId": "stop-transcribe", "param": ""}
User: "start" → {"commandId": "start-transcribe", "param": ""}
User: "send" → {"commandId": "press-enter", "param": ""}
User: "go home" → {"commandId": "navigate-home", "param": ""}
User: "show active sessions" → {"commandId": "navigate-sessions", "param": ""}
User: "show all" → {"commandId": "show-all", "param": ""}
User: "new terminal" → {"commandId": "new-terminal", "param": ""}
User: "new hivemind" → {"commandId": "new-hivemind", "param": ""}
User: "close terminal" → {"commandId": "close-terminal", "param": ""}
User: "close hivemind" → {"commandId": "close-hivemind", "param": ""}
User: "close project" → {"commandId": "close-project", "param": ""}
User: "close project samsung" → {"commandId": "close-project", "param": "samsung"}
User: "delete three words" → {"commandId": "delete-words", "param": "3"}
User: "remove five words" → {"commandId": "delete-words", "param": "5"}
User: "delete 2 words" → {"commandId": "delete-words", "param": "2"}
User: "clear text" → {"commandId": "clear-text", "param": ""}
User: "clear line" → {"commandId": "clear-text", "param": ""}
User: "refresh tab" → {"commandId": "refresh-tab", "param": ""}
User: "refresh now" → {"commandId": "refresh-page", "param": ""}
User: "stop hivecommand" → {"commandId": "dismiss-commands", "param": ""}
User: "stop listening" → {"commandId": "stop-listening", "param": ""}

IMPORTANT: "open project <name>" is ALWAYS navigate-project, NOT navigate-home. navigate-home is only for "go home" or "show all projects" with NO project name after it.

CRITICAL: Only match a command if the utterance IS the command (possibly with a parameter). If the utterance is a natural sentence that happens to contain a command word, return null. For example:
- "stop" → stop-transcribe (standalone command)
- "go ahead and then stop the server" → null (natural speech, "stop" is not a command here)
- "send the email to john" → null (natural speech, not a "send" command)
- "send" → press-enter (standalone command)
- "delete three words" → delete-words with param "3" (command with parameter)
- "I need to delete those files" → null (natural speech)
The command words must be at the beginning of the utterance, not buried in a longer sentence.

If nothing matches: {"commandId": null, "param": ""}
Be lenient with transcription errors. Return ONLY valid JSON.`;

  const body = JSON.stringify({
    model: 'gpt-5-mini',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: text },
    ],
    temperature: 0,
    max_tokens: 80,
    response_format: { type: 'json_object' },
  });

  const start = Date.now();

  return new Promise((resolve) => {
    const req = https.request(
      {
        hostname: 'api.openai.com',
        path: '/v1/chat/completions',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
          'Content-Length': Buffer.byteLength(body),
        },
        timeout: 5000,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
        res.on('end', () => {
          const elapsed = (Date.now() - start) / 1000;

          if (!res.statusCode || res.statusCode >= 400) {
            console.error(`[STT] GPT-5 mini classifier error (${res.statusCode}): ${data}`);
            resolve(null);
            return;
          }

          try {
            const json = JSON.parse(data);
            const content = json.choices?.[0]?.message?.content;
            if (!content) {
              console.error(`[STT] GPT-5 mini: empty response (${elapsed.toFixed(1)}s)`);
              resolve(null);
              return;
            }

            const result = JSON.parse(content);
            if (result.commandId) {
              console.error(`[STT] GPT-5 mini classified "${text}" → ${result.commandId} (param: "${result.param || ''}") in ${elapsed.toFixed(1)}s`);
              resolve({ commandId: result.commandId, param: result.param || '' });
            } else {
              console.error(`[STT] GPT-5 mini: no command matched for "${text}" (${elapsed.toFixed(1)}s)`);
              resolve(null);
            }
          } catch (e) {
            console.error(`[STT] GPT-5 mini: failed to parse response (${elapsed.toFixed(1)}s):`, data);
            resolve(null);
          }
        });
      },
    );

    req.on('error', (e) => {
      console.error(`[STT] GPT-5 mini request error: ${e.message}`);
      resolve(null);
    });
    req.on('timeout', () => {
      console.error('[STT] GPT-5 mini request timed out');
      req.destroy();
      resolve(null);
    });

    req.write(body);
    req.end();
  });
}
