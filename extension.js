const vscode = require('vscode');
const { writeGlobalStorageData, readGlobalStorageData } = require('./data.js');

const BASE_PROMPT = `You are a coding tutor. A journal entry (provided in context) lists concepts/syntax the user already knows.

For each concept/syntax needed to fulfill the user's request:
- If it's in the journal (already known): do NOT give the answer. Prompt the user to try it themselves by refering to the right journal entry, with a hint but no solution.
- If it's NOT in the journal (new): explain it with a guided overview and show the code, across a series of short messages.

End your response with one line per new concept/syntax identified that is not in the journal, each wrapped in <json></json> tags, using this exact schema: {"name": string, "known": boolean, "description": string}. Never use <json> tags elsewhere, including in code examples.

Example:
<json>{"name": "for loop", "known": false, "description": "Iterates over a sequence of values"}</json>
<json>{"name": "console.log", "known": true, "description": "Prints output to the console"}</json>
`;

/**
 * @param {import('vscode').ExtensionContext} context
 */
async function activate(context) {

    /**
     * @param {import('vscode').LanguageModelChatResponse} chatResponse
     * @param {import('vscode').ChatResponseStream} stream
     */
    async function parseAndStreamResponse(chatResponse, stream) {
        const OPEN_TAG = '<json>';
        const CLOSE_TAG = '</json>';

        let textBuffer = '';      // accumulates raw fragments to scan for tags
        let inJson = false;
        let jsonBuffer = '';
        const jsonChunks = [];

        for await (const fragment of chatResponse.text) {
            textBuffer += fragment;

            // Keep processing as long as we can find a complete tag boundary
            let progress = true;
            while (progress) {
                progress = false;

                if (!inJson) {
                    const openIdx = textBuffer.indexOf(OPEN_TAG);
                    if (openIdx !== -1) {
                        // Stream everything before the tag as plain text
                        const plainText = textBuffer.slice(0, openIdx);
                        if (plainText) {
                            stream.markdown(plainText);
                        }
                        textBuffer = textBuffer.slice(openIdx + OPEN_TAG.length);
                        inJson = true;
                        jsonBuffer = '';
                        progress = true;
                    } else {
                        // No open tag yet — but don't flush the whole buffer,
                        // in case it ends mid-tag (e.g. "...text<js"). Hold back
                        // a small tail equal to the tag length just in case.
                        const safeFlushLen = Math.max(0, textBuffer.length - OPEN_TAG.length);
                        if (safeFlushLen > 0) {
                            stream.markdown(textBuffer.slice(0, safeFlushLen));
                            textBuffer = textBuffer.slice(safeFlushLen);
                        }
                    }
                } else {
                    const closeIdx = textBuffer.indexOf(CLOSE_TAG);
                    if (closeIdx !== -1) {
                        jsonBuffer += textBuffer.slice(0, closeIdx);
                        jsonChunks.push(jsonBuffer);
                        textBuffer = textBuffer.slice(closeIdx + CLOSE_TAG.length);
                        inJson = false;
                        jsonBuffer = '';
                        progress = true;
                    } else {
                        // Still inside JSON, no close tag yet — but the same
                        // "</json>" tag could be split across this fragment and
                        // the next one, so hold back a tail equal to the tag
                        // length instead of consuming everything blindly.
                        const safeFlushLen = Math.max(0, textBuffer.length - CLOSE_TAG.length);
                        if (safeFlushLen > 0) {
                            jsonBuffer += textBuffer.slice(0, safeFlushLen);
                            textBuffer = textBuffer.slice(safeFlushLen);
                        }
                    }
                }
            }
        }

        // Stream ended — handle whatever's left in the buffers.
        if (inJson) {
            // The model never emitted a closing </json>. Don't silently drop
            // the content: fold the leftover tail back in and keep what we have.
            jsonBuffer += textBuffer;
            textBuffer = '';
            if (jsonBuffer.trim()) {
                console.warn('parseAndStreamResponse: stream ended with an unterminated <json> block; attempting to parse partial content.');
                jsonChunks.push(jsonBuffer);
            }
        } else if (textBuffer) {
            stream.markdown(textBuffer);
        }

        // Parse all collected JSON chunks
        const concepts = [];
        for (const chunk of jsonChunks) {
            try {
                concepts.push(JSON.parse(chunk.trim()));
            } catch (e) {
                console.log('Failed to parse JSON chunk:', chunk, e);
            }
        }

        writeGlobalStorageData(context, "journal", concepts);
        console.log(concepts);
        return concepts;
    }

    const journalEntry = await readGlobalStorageData(context, "journal");

    /** @type {import('vscode').ChatRequestHandler} */
    const handler = async (request, context, stream, token) => {
        let prompt = BASE_PROMPT;

        const messages = [vscode.LanguageModelChatMessage.User(prompt)];
        const previousMessages = context.history.filter(
            (h) => h instanceof vscode.ChatResponseTurn
        );
        previousMessages.forEach((m) => {
            let fullMessage = '';
            m.response.forEach((r) => {
                fullMessage += r.value;
            });
            messages.push(vscode.LanguageModelChatMessage.Assistant(fullMessage));
        });

        messages.push(
            vscode.LanguageModelChatMessage.User(
                `Here is the journal entry: ${JSON.stringify(journalEntry)}`
            )
        );
        messages.push(vscode.LanguageModelChatMessage.User(request.prompt));

        const chatResponse = await request.model.sendRequest(messages, {}, token);

        await parseAndStreamResponse(chatResponse, stream);

        stream.button({
            command: 'code-tutor.show',
            title: vscode.l10n.t('Save in journal')
        });

    };

    const tutor = vscode.chat.createChatParticipant("17sf.code-expert", handler);
    tutor.iconPath = vscode.Uri.joinPath(context.extensionUri, 'images', '17sf_extension_logo.jpg');

    const disposable = vscode.commands.registerCommand('code-tutor.show', async () => {
        const panel = vscode.window.createWebviewPanel(
            'showJournal',
            'Journal',
            vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true
            }
        );
        const currentJournal = await readGlobalStorageData(context, "journal");
        panel.webview.html = getWebViewContent(currentJournal);
    });

    context.subscriptions.push(disposable);
}
/**
 * @param {*} journalEntries
 */
function getWebViewContent(journalEntries) {
    return `<!DOCTYPE html>
<html>
  <head>
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline';">
    <style>
:root {
  --primary-50: #E3F2FD;
  --primary-100: #BBDEFB;
  --primary-300: #90CAF9;
  --primary-500: #2196F3;
  --primary-900: #0D47A1;
  --text: #123B6D;
  --surface: #F7FBFF;
  --card: #FFFFFF;
  --border: #CFE4FF;
  --muted: #5B7DA3;
}

body {
  font-family: 'Segoe UI', sans-serif;
  color: var(--text);
  background: linear-gradient(180deg, var(--primary-50) 0%, #F8FBFF 100%);
  padding: 0;
  margin: 0;
  font-size: 13px;
}
.tab-bar {
  display: flex;
  border-bottom: 1px solid var(--border);
  background: rgba(255,255,255,0.5);
  backdrop-filter: blur(4px);
}
.tab-btn {
  flex: 1;
  padding: 12px 0;
  text-align: center;
  background: transparent;
  border: none;
  color: var(--text);
  cursor: pointer;
  font-size: 13px;
  border-bottom: 2px solid transparent;
  transition: all 0.2s ease;
}
.tab-btn.active {
  border-bottom: 2px solid var(--primary-500);
  font-weight: 700;
  background: rgba(33, 150, 243, 0.06);
}
.view { display: none; padding: 16px; }
.view.active { display: block; }

.concept-card {
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 14px 14px 12px;
  margin-bottom: 12px;
  box-shadow: 0 3px 10px rgba(13, 71, 161, 0.06);
  transition: border-color 0.2s ease, transform 0.2s ease, box-shadow 0.2s ease;
}
.concept-card:hover {
  transform: translateY(-1px);
  box-shadow: 0 6px 16px rgba(13, 71, 161, 0.08);
}
.concept-card.selected {
  border-color: var(--primary-500);
  box-shadow: 0 0 0 2px rgba(33, 150, 243, 0.12);
}
.concept-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 4px;
}
.concept-title { font-weight: 700; color: var(--primary-900); }
.badge {
  font-size: 11px;
  padding: 4px 8px;
  border-radius: 999px;
  font-weight: 600;
}
.badge.familiar { background: rgba(33, 150, 243, 0.12); color: var(--primary-900); }
.badge.new { background: rgba(144, 202, 249, 0.22); color: var(--primary-900); }
.concept-desc { color: var(--muted); margin: 4px 0 8px; }
.concept-note {
  color: var(--muted);
  font-size: 11px;
  margin: 0 0 10px;
  line-height: 1.4;
}
.btn-row { display: flex; gap: 8px; }
button.action {
  flex: 1;
  padding: 8px 10px;
  background: linear-gradient(180deg, var(--primary-50) 0%, #DBEDFF 100%);
  color: var(--primary-900);
  border: 1px solid var(--primary-100);
  border-radius: 8px;
  cursor: pointer;
  font-size: 12px;
  font-weight: 600;
}
button.action:hover { background: linear-gradient(180deg, #DBEDFF 0%, #CFE8FF 100%); }

.coach-feedback {
  margin-top: 10px;
  padding: 10px 12px;
  border-radius: 10px;
  font-size: 12px;
  line-height: 1.55;
}
.coach-feedback.hint {
  background: rgba(33, 150, 243, 0.08);
  border: 1px solid rgba(33, 150, 243, 0.2);
}
.coach-feedback.steps {
  background: rgba(13, 71, 161, 0.06);
  border: 1px solid rgba(13, 71, 161, 0.18);
}
.coach-feedback ol {
  margin: 6px 0 0 18px;
  padding: 0;
}
.step-item {
  margin-bottom: 10px;
}
.step-text {
  margin-bottom: 6px;
  color: var(--text);
}
.step-code {
  background: #0d1b2a;
  color: #e3f2fd;
  border-radius: 8px;
  padding: 8px 10px;
  margin: 0;
  overflow-x: auto;
  font-size: 11px;
  line-height: 1.5;
}

.lang-filter { display: flex; gap: 6px; margin-bottom: 14px; }
.lang-filter button {
  background: rgba(255,255,255,0.7); border: 1px solid var(--border);
  color: var(--text); border-radius: 999px; padding: 5px 11px;
  cursor: pointer; font-size: 12px;
}
.lang-filter button.active {
  background: var(--primary-500);
  border-color: var(--primary-500);
  color: white;
}
.journal-overview {
  background: linear-gradient(135deg, rgba(33,150,243,0.12), rgba(144,202,249,0.18));
  border: 1px solid rgba(33,150,243,0.25);
  border-radius: 12px;
  padding: 12px 14px;
  margin-bottom: 12px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  box-shadow: 0 6px 18px rgba(13,71,161,0.08);
}
.journal-overview-label {
  color: var(--primary-900);
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.03em;
  font-weight: 700;
}
.journal-overview-value {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: rgba(13,71,161,0.08);
  border: 1px solid rgba(13,71,161,0.14);
  color: var(--primary-900);
  border-radius: 999px;
  padding: 6px 10px;
  font-size: 15px;
  font-weight: 800;
}
.journal-overview-value::before {
  content: '🔥';
  font-size: 13px;
}
.journal-header {
  display: block;
  padding: 10px 12px 8px;
  color: var(--muted);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.02em;
  text-transform: uppercase;
}
.weak-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px;
  border-bottom: 1px solid var(--border);
  cursor: pointer;
  border-radius: 8px;
  transition: background 0.15s ease;
}
.weak-row:hover { background: rgba(144, 202, 249, 0.12); }
.weak-row.selected { background: rgba(33, 150, 243, 0.1); }
.weak-row .name { display: flex; align-items: center; gap: 8px; }
.weak-row input[type="checkbox"] { pointer-events: none; accent-color: var(--primary-500); }

#concept-detail { display: none; }
#concept-detail.active { display: block; }
.back-link { cursor: pointer; color: var(--primary-900); font-size: 12px; margin-bottom: 10px; font-weight: 600; }
.stat-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-bottom: 14px; }
.stat-box { background: rgba(255,255,255,0.7); border: 1px solid var(--border); border-radius: 10px; padding: 10px 10px; }
.stat-box .label { font-size: 11px; color: var(--muted); }
.stat-box .value { font-size: 16px; font-weight: 700; color: var(--primary-900); }
.history-row {
  display: flex; justify-content: space-between; padding: 7px 0;
  border-bottom: 1px solid var(--border); font-size: 12px;
  color: var(--muted);
}
    </style>
  </head>
  <body>
<div class="tab-bar">
  <button class="tab-btn active" data-view="coach">Coach</button>
  <button class="tab-btn" data-view="journal">Journal</button>
</div>

<div id="coach-view" class="view active">
  <div id="concept-list"></div>
</div>

<div id="journal-view" class="view">
  <div id="journal-list-view">
    <div class="lang-filter" id="lang-filter">
      <button data-lang="all" class="active">All</button>
      <button data-lang="html">HTML</button>
      <button data-lang="css">CSS</button>
      <button data-lang="js">JS</button>
    </div>
    <div id="weak-concepts"></div>
  </div>

  <div id="concept-detail">
    <div class="back-link" id="back-to-journal">&larr; All concepts</div>
    <h3 id="detail-title"></h3>
    <div class="stat-grid">
      <div class="stat-box"><div class="label">Daily recap streak</div><div class="value" id="detail-streak"></div></div>
      <div class="stat-box"><div class="label">Total seen</div><div class="value" id="detail-total"></div></div>
      <div class="stat-box"><div class="label">Unaided rate</div><div class="value" id="detail-rate"></div></div>
    </div>
    <div id="detail-history"></div>
  </div>
</div>
    <script>
    
    
      const journalEntries = ${JSON.stringify(journalEntries)};
      const body = document.querySelector('body');

      for (let i = 0; i < journalEntries.length; i++) {
        const [date, ...turns] = journalEntries[i];

        const heading = document.createElement('h2');
        heading.textContent = date;
        heading.classList.add('date-heading');
        body.appendChild(heading);

        for (let j = 0; j < turns.length; j++) {
          const concepts = turns[j];
          for (let k = 0; k < concepts.length; k++) {
            const concept = concepts[k];
            if (!concept || typeof concept.name !== 'string') {
              continue; // skip malformed entries
            }

            const card = document.createElement('div');
            const title = document.createElement('h1');
            const description = document.createElement('p');
            title.textContent = concept.name;
            title.style.color = "white";
            description.style.color = "white";
            description.textContent = concept.description;
            card.classList.add('card');
            card.appendChild(title);
            card.appendChild(description);

            body.appendChild(card);
          }
        }
      }
    </script>
  </body>
</html>`;
}


function deactivate() { }

module.exports = {
  activate,
  deactivate
};