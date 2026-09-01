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

function getClientScript() {
  return `
    const vscode = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : null;

    function safePostMessage(message) {
      if (vscode) {
        vscode.postMessage(message);
        return;
      }
      console.log('Webview message:', message);
    }

    const conceptLibrary = {
      c1: {
        id: 'c1',
        title: 'array destructuring',
        desc: 'Extract values from arrays into variables',
        familiar: true,
        note: "You've used this pattern 6 times. Try recalling before asking for help.",
        hint: 'Think of it as unpacking a list into separate variables, in the same order they appear.',
        steps: [
          'Create an array with values in a known order.',
          'Write variables on the left side inside brackets.',
          'Use those variables in your code instead of indexing repeatedly.'
        ],
        streak: 4,
        total: 12,
        rate: 32,
        history: [
          { date: 'Aug 15', file: 'app.js', action: 'Reviewed' },
          { date: 'Aug 16', file: 'helpers.js', action: 'Used in refactor' },
          { date: 'Aug 18', file: 'main.js', action: 'Practiced' }
        ]
      },
      c2: {
        id: 'c2',
        title: 'prime number checking',
        desc: 'Tests divisibility to determine primality',
        familiar: false,
        note: null,
        hint: 'Check divisibility by iterating only up to the square root of the number.',
        steps: [
          'Handle small values first.',
          'Loop through possible divisors.',
          'Return false as soon as a divisor is found.'
        ],
        streak: 2,
        total: 9,
        rate: 58,
        history: [
          { date: 'Aug 14', file: 'math.js', action: 'Reviewed' },
          { date: 'Aug 17', file: 'challenge.js', action: 'Tried' },
          { date: 'Aug 18', file: 'exercise.js', action: 'Revisited' }
        ]
      },
      c3: {
        id: 'c3',
        title: 'async generators',
        desc: 'Yield values over time with async control flow',
        familiar: false,
        note: null,
        hint: 'A generator can pause execution, and async allows waiting without blocking the rest of the app.',
        steps: [
          'Define an async generator function.',
          'Use yield to emit values one at a time.',
          'Await each value when consuming it.'
        ],
        streak: 1,
        total: 6,
        rate: 67,
        history: [
          { date: 'Aug 12', file: 'fetch.js', action: 'Read' },
          { date: 'Aug 18', file: 'stream.js', action: 'Practice set' }
        ]
      }
    };

    let state = {
      coach: [
        { id: 'c1' },
        { id: 'c2' },
         {id: 'c3'}
      ],
      journalByLang: {
        all: [
          { id: 'c1', title: 'array destructuring', reinforced: true },
          { id: 'c2', title: 'prime number checking', reinforced: false },
          { id: 'c3', title: 'async generators', reinforced: false }
        ],
        html: [
          { id: 'c1', title: 'array destructuring', reinforced: true }
        ],
        css: [
          { id: 'c2', title: 'prime number checking', reinforced: false }
        ],
        js: [
          { id: 'c3', title: 'async generators', reinforced: false },
          { id: 'c2', title: 'prime number checking', reinforced: false }
        ]
      },
      feedback: {},
      activeLang: 'all',
      selectedConceptId: null
    };

    function getConcept(id) {
      return conceptLibrary[id] || null;
    }

    function renderCoach() {
      const list = document.getElementById('concept-list');
      list.innerHTML = state.coach.map(c => {
        const concept = getConcept(c.id);
        console.log(concept);
        const feedback = state.feedback[c.id];
        if (!concept) return '';

        return \`
          <div class="concept-card \${state.selectedConceptId === c.id ? 'selected' : ''}">
            <div class="concept-header">
              <span class="concept-title">\${concept.title}</span>
              <span class="badge \${concept.familiar ? 'familiar' : 'new'}">\${concept.familiar ? 'Seen before' : 'New concept'}</span>
            </div>
            <div class="concept-desc">\${concept.desc}</div>
            \${concept.note ? \`<div class="concept-note">\${concept.note}</div>\` : ''}
            <div class="btn-row">
              <button class="action" data-action="hint" data-id="\${concept.id}">Hint</button>
              <button class="action" data-action="steps" data-id="\${concept.id}">Step by step</button>
            </div>
            \${feedback ? \`
              <div class="coach-feedback \${feedback.type}">
                \${feedback.type === 'hint' ? \`💡 \${feedback.text}\` : feedback.text}
              </div>
            \` : ''}
          </div>
        \`;
      }).join('');
    }

    function renderJournal(lang = state.activeLang) {
      const items = state.journalByLang[lang] || [];
      const container = document.getElementById('weak-concepts');
      container.innerHTML = items.map(c => \`
        <div class="weak-row \${state.selectedConceptId === c.id ? 'selected' : ''}" data-id="\${c.id}">
          <span class="name">
            <input type="checkbox" \${c.reinforced ? 'checked' : ''} />
            \${c.title}
          </span>
        </div>
      \`).join('');
    }

    function openConceptDetail(id) {
      const concept = getConcept(id);
      if (!concept) return;

      state.selectedConceptId = id;
      document.getElementById('journal-list-view').style.display = 'none';
      document.getElementById('concept-detail').classList.add('active');
      document.getElementById('detail-title').textContent = concept.title;
      document.getElementById('detail-streak').textContent = concept.streak;
      document.getElementById('detail-total').textContent = concept.total;
      document.getElementById('detail-rate').textContent = concept.rate + '%';
      document.getElementById('detail-history').innerHTML = concept.history.map(h => \`
        <div class="history-row"><span>\${h.date} &middot; \${h.file}</span><span>\${h.action}</span></div>
      \`).join('');

      renderCoach();
      renderJournal();
    }

    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
        btn.classList.add('active');
        document.getElementById(\`\${btn.dataset.view}-view\`).classList.add('active');
      });
    });

    document.getElementById('lang-filter').addEventListener('click', (e) => {
      if (e.target.tagName !== 'BUTTON') return;
      document.querySelectorAll('#lang-filter button').forEach(b => b.classList.remove('active'));
      e.target.classList.add('active');
      state.activeLang = e.target.dataset.lang;
      renderJournal(state.activeLang);
    });

    document.getElementById('concept-list').addEventListener('click', (e) => {
      const btn = e.target.closest('button.action');
      if (!btn) return;

      const conceptId = btn.dataset.id;
      const concept = getConcept(conceptId);
      if (!concept) return;

      if (btn.dataset.action === 'hint') {
        state.feedback[conceptId] = {
          type: 'hint',
          text: concept.hint
        };
        safePostMessage({ command: 'requestHint', conceptId });
      }

      if (btn.dataset.action === 'steps') {
        state.feedback[conceptId] = {
          type: 'steps',
          text: \`<ol>\${concept.steps.map(step => \`<li>\${step}</li>\`).join('')}</ol>\`
        };
        safePostMessage({ command: 'requestSteps', conceptId });
      }

      renderCoach();
    });

    document.getElementById('weak-concepts').addEventListener('click', (e) => {
      const row = e.target.closest('.weak-row');
      if (!row) return;

      const conceptId = row.dataset.id;
      safePostMessage({ command: 'selectConcept', conceptId });
      openConceptDetail(conceptId);
    });

    document.getElementById('back-to-journal').addEventListener('click', () => {
      state.selectedConceptId = null;
      document.getElementById('concept-detail').classList.remove('active');
      document.getElementById('journal-list-view').style.display = 'block';
      renderCoach();
      renderJournal();
    });

    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (msg.type === 'init') {
        state = { ...state, ...msg.data };
        renderCoach();
        renderJournal();
      }
      if (msg.type === 'conceptDetail') {
        openConceptDetail(msg.data.id || msg.data.conceptId);
      }
    });

    renderCoach();
    renderJournal();
  `;
}
/**
 * @param {*} journalEntries
 */
function getWebViewContent(journalEntries) {
  const clientScript = getClientScript();

  return `<!DOCTYPE html>
  <head>
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline';">
    <style>
:root {
  --vscode-font-family: 'Segoe UI', sans-serif;
  --vscode-foreground: #1f1f1f;
  --vscode-editor-background: #ffffff;
  --vscode-panel-border: #d0d0d0;
  --vscode-editorWidget-background: #f5f5f5;
  --vscode-descriptionForeground: #5c5c5c;
  --vscode-button-secondaryBackground: #efefef;
  --vscode-button-secondaryForeground: #1f1f1f;
  --vscode-button-secondaryHoverBackground: #e2e2e2;
  --vscode-focusBorder: #0078d4;
  --vscode-list-hoverBackground: #eaf3ff;
  --vscode-textLink-foreground: #0066cc;
}

body {
  font-family: var(--vscode-font-family, 'Segoe UI', sans-serif);
  color: var(--vscode-foreground, #1f1f1f);
  background: var(--vscode-editor-background, #ffffff);
  padding: 0;
  margin: 0;
  font-size: 13px;
}
.tab-bar {
  display: flex;
  border-bottom: 1px solid var(--vscode-panel-border, #d0d0d0);
}
.tab-btn {
  flex: 1;
  padding: 10px 0;
  text-align: center;
  background: none;
  border: none;
  color: var(--vscode-foreground, #1f1f1f);
  cursor: pointer;
  font-size: 13px;
  border-bottom: 2px solid transparent;
}
.tab-btn.active {
  border-bottom: 2px solid var(--vscode-focusBorder, #0078d4);
  font-weight: 600;
}
.view { display: none; padding: 16px; }
.view.active { display: block; }

.concept-card {
  background: var(--vscode-editorWidget-background, #f5f5f5);
  border: 1px solid var(--vscode-panel-border, #d0d0d0);
  border-radius: 6px;
  padding: 12px 14px;
  margin-bottom: 10px;
  transition: border-color 0.2s ease, box-shadow 0.2s ease;
}
.concept-card.selected {
  border-color: var(--vscode-focusBorder, #0078d4);
  box-shadow: 0 0 0 1px rgba(0, 120, 212, 0.12);
}
.concept-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 4px;
}
.concept-title { font-weight: 600; }
.badge {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 10px;
}
.badge.familiar { background: #1d9e7530; color: #1d9e75; }
.badge.new { background: #ef9f2730; color: #ef9f27; }
.concept-desc { color: var(--vscode-descriptionForeground, #5c5c5c); margin: 4px 0 8px; }
.concept-note {
  color: var(--vscode-descriptionForeground, #5c5c5c);
  font-size: 11px;
  margin: 0 0 10px;
  line-height: 1.4;
}
.btn-row { display: flex; gap: 8px; }
button.action {
  flex: 1;
  padding: 6px 10px;
  background: var(--vscode-button-secondaryBackground, #efefef);
  color: var(--vscode-button-secondaryForeground, #1f1f1f);
  border: 1px solid var(--vscode-panel-border, #d0d0d0);
  border-radius: 4px;
  cursor: pointer;
  font-size: 12px;
}
button.action:hover { background: var(--vscode-button-secondaryHoverBackground, #e2e2e2); }

.coach-feedback {
  margin-top: 10px;
  padding: 8px 10px;
  border-radius: 6px;
  font-size: 12px;
  line-height: 1.5;
}
.coach-feedback.hint {
  background: rgba(0, 120, 212, 0.08);
  border: 1px solid rgba(0, 120, 212, 0.2);
  color: var(--vscode-foreground, #1f1f1f);
}
.coach-feedback.steps {
  background: rgba(29, 158, 117, 0.08);
  border: 1px solid rgba(29, 158, 117, 0.2);
  color: var(--vscode-foreground, #1f1f1f);
}
.coach-feedback ol {
  margin: 6px 0 0 18px;
  padding: 0;
}

.lang-filter { display: flex; gap: 6px; margin-bottom: 14px; }
.lang-filter button {
  background: none; border: 1px solid var(--vscode-panel-border, #d0d0d0);
  color: var(--vscode-foreground, #1f1f1f); border-radius: 4px; padding: 4px 10px;
  cursor: pointer; font-size: 12px;
}
.lang-filter button.active {
  border-color: var(--vscode-focusBorder, #0078d4);
  color: var(--vscode-focusBorder, #0078d4);
}
.weak-row {
  display: flex; align-items: center; justify-content: space-between;
  padding: 8px 10px; border-bottom: 1px solid var(--vscode-panel-border, #d0d0d0);
  cursor: pointer;
}
.weak-row:hover { background: var(--vscode-list-hoverBackground, #eaf3ff); }
.weak-row.selected { background: rgba(0, 120, 212, 0.08); }
.weak-row .name { display: flex; align-items: center; gap: 8px; }
.weak-row input[type="checkbox"] { pointer-events: none; }

#concept-detail { display: none; }
#concept-detail.active { display: block; }
.back-link { cursor: pointer; color: var(--vscode-textLink-foreground, #0066cc); font-size: 12px; margin-bottom: 10px; }
.stat-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-bottom: 14px; }
.stat-box { background: var(--vscode-editorWidget-background, #f5f5f5); border-radius: 6px; padding: 8px 10px; }
.stat-box .label { font-size: 11px; color: var(--vscode-descriptionForeground, #5c5c5c); }
.stat-box .value { font-size: 16px; font-weight: 600; }
.history-row {
  display: flex; justify-content: space-between; padding: 6px 0;
  border-bottom: 1px solid var(--vscode-panel-border, #d0d0d0); font-size: 12px;
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
    <script>${clientScript}</script>
  </body>
</html>`;
}


function deactivate() { }

module.exports = {
  activate,
  deactivate
};