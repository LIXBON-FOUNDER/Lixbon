// docsContent.en.jsx — English content for lixbon Docs. Each section is a
// component that receives `base` (the gateway origin) for the examples. The
// index, titles and descriptions live in docsIndex.js (shared with the
// sitemap); docsContent.js merges this file with docsContent.es.jsx.
import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { CodeBlock } from '../components/CodeBlock';
import { IconShield } from '../components/Icons';
import { Link } from '../i18n/link';

function Callout({ children }) {
  return (
    <div className="docs__callout">
      <IconShield size={17} />
      <p>{children}</p>
    </div>
  );
}

function Introduction() {
  return (
    <>
      <h1>What is lixbon?</h1>
      <p className="docs__lead">
        lixbon is an AI platform that runs on its own GPU cluster. You chat with
        language models from the web, code with an agent from the terminal or the
        IDE, design sites in Visuals, and, if you build software, integrate the
        same models into your code with an OpenAI-compatible API.
      </p>

      <h2>How it works</h2>
      <p>
        Your messages hit a <strong>gateway</strong> that routes them to the best
        available GPU node in the cluster and streams the response back token by
        token. You don&apos;t depend on an external provider: inference runs on our
        own hardware, and the orchestrator balances load and routes around any
        node that goes down. Each job (chat, vision, code completion, embeddings)
        is handled by whichever model does it best.
      </p>

      <h2>Ways to use lixbon</h2>
      <ul>
        <li><strong><Link to="/docs/chat">Web chat</Link></strong> — the fastest way to start, nothing to install.</li>
        <li><strong><Link to="/docs/visuals">Visuals</Link></strong> — design landing pages, dashboards, emails, logos and navigable prototypes by talking to the model.</li>
        <li><strong><Link to="/docs/cli">CLI</Link></strong> — terminal chat with agent mode: reads and edits your project, runs commands, and makes commits.</li>
        <li><strong><Link to="/docs/desktop">Desktop app</Link></strong> — an IDE with built-in autocomplete, chat and agent.</li>
        <li><strong><Link to="/docs/remote">Remote</Link></strong> — follow and steer an agent session from your phone.</li>
        <li><strong><Link to="/docs/api">API</Link></strong> — OpenAI-compatible endpoints for your own applications.</li>
      </ul>

      <Callout>
        Ready to get started? Continue with <Link to="/docs/getting-started">Getting started</Link>.
      </Callout>
    </>
  );
}

function GettingStarted() {
  return (
    <>
      <h1>Getting started</h1>
      <p className="docs__lead">
        Create your account and send your first message in under a minute.
      </p>

      <h2>1. Create an account</h2>
      <p>
        Go to <Link to="/chat">chat</Link> and sign up with your email, name and a
        password. On sign-up you get the <strong>Free</strong> plan, enough to try
        the platform: 30 messages a day and 150,000 tokens a month.
      </p>

      <h2>2. Send your first message</h2>
      <p>
        Type in the text box and hit Enter. The response streams in. Every
        conversation is saved to your history and you can pick it back up, rename
        it, share it via link, or delete it whenever you want.
      </p>

      <h2>3. Pick a model</h2>
      <p>
        You can switch models from the composer. If you don&apos;t pick one, the
        gateway uses whatever model is assigned to the chat role. Reasoning models
        show their &ldquo;thinking&rdquo; before the answer.
      </p>

      <h2>4. Design something in Visuals</h2>
      <p>
        In <Link to="/visuals">Visuals</Link> you describe a website, a dashboard
        or a prototype and the model builds it in HTML; then you fine-tune it by
        talking to it or clicking elements on the canvas. More in{' '}
        <Link to="/docs/visuals">Visuals</Link>.
      </p>

      <h2>5. Bring lixbon to your terminal or your editor</h2>
      <p>
        When you want it while you code, install the{' '}
        <Link to="/docs/cli">CLI</Link> or the <Link to="/docs/desktop">desktop app</Link>.
        Both sign in with your email and password, or with an API key.
      </p>
    </>
  );
}

function WebChat() {
  return (
    <>
      <h1>Web chat</h1>
      <p className="docs__lead">
        The chat at <Link to="/chat">lixbon.com</Link> is the front door:
        conversations with streaming, history, attachments and web search,
        nothing to install.
      </p>

      <h2>Models and reasoning</h2>
      <p>
        The composer&apos;s model picker lists the cluster&apos;s active models. The
        ones that reason (DeepSeek-R1, Qwen 3, gpt-oss…) show their thinking in a
        collapsible block before the answer; the reasoning level adjusts
        automatically based on the model and the task.
      </p>

      <h2>Attachments</h2>
      <p>
        Using the paperclip, pasting, or dragging and dropping, you can attach
        images and documents (PDF, Word, text, Markdown, CSV, JSON, code…).
        Images are read by the cluster&apos;s vision model; documents are converted
        to text and added to the conversation&apos;s context.
      </p>

      <h2>Dictation and web search</h2>
      <ul>
        <li>The <strong>microphone</strong> dictates your message using the browser&apos;s speech recognition.</li>
        <li>The <strong>globe</strong> turns on web search for every response; leave it off and the model decides when to search.</li>
      </ul>

      <h2>History and public links</h2>
      <p>
        Conversations are saved in the sidebar: rename them, search them, or
        delete them. From a conversation&apos;s menu you can create a{' '}
        <strong>public link</strong> that&apos;s read-only, and stop sharing it
        whenever you want. If you turn off &ldquo;Conversation history&rdquo; in{' '}
        <Link to="/account/privacy">Settings → Privacy</Link>, new chats aren&apos;t saved.
      </p>

      <h2>Limits</h2>
      <p>
        Chat with a signed-in session draws from your plan&apos;s quota (messages
        per day and tokens per month). When you hit the limit, the interface
        tells you when it resets and how to{' '}
        <Link to="/plans">upgrade your plan</Link>.
      </p>
    </>
  );
}

function Visuals() {
  return (
    <>
      <h1>Visuals</h1>
      <p className="docs__lead">
        In <Link to="/visuals">Visuals</Link> you describe what you want and the
        model builds it in HTML with Tailwind; then you fine-tune it by talking to
        it or clicking on the canvas. Each design lives in its own conversation,
        with versions.
      </p>

      <h2>What you can design</h2>
      <ul>
        <li><strong>Landing page</strong>, <strong>Component</strong> (card, table, form…), <strong>Dashboard</strong> and <strong>Email</strong> (tables and inline styles).</li>
        <li><strong>Logo / SVG</strong>: logos and vector illustrations.</li>
        <li><strong>Prototype</strong>: several screens linked together (<code>index.html</code>, <code>contact.html</code>…), navigable from the preview.</li>
        <li><strong>Image</strong>: image generation, when a cluster node that generates images is available.</li>
      </ul>

      <h2>Design systems</h2>
      <p>
        Before asking for a design, you can pin a design system (Lixbon,
        Editorial, Minimal, Corporate, Vibrant, Dark tech) or define your own with
        an accent, background, text, fonts and tone. It applies to every page and
        version of the design.
      </p>

      <h2>The editor</h2>
      <ul>
        <li><strong>Pages</strong>: the chip next to the name switches pages or shows the <strong>Canvas</strong> with all of them at once.</li>
        <li><strong>Versions</strong>: every model response is a version; jump back to any of them from the <code>v3 ▾</code> chip.</li>
        <li><strong>Select</strong>: click an element in the preview to edit its text or styles by hand, or to ask the model for a change scoped to that element.</li>
        <li><strong>Code</strong>: the HTML of the current page.</li>
        <li><strong>Present</strong>: opens the design full screen in another tab, with page-to-page navigation working.</li>
      </ul>
      <p>
        Small edits don&apos;t rewrite the page: the model sends search-and-replace
        blocks that apply on top of the previous version. If a block doesn&apos;t
        match, the page stays as it was and you can ask for the full file instead.
      </p>

      <h2>Share and export</h2>
      <ul>
        <li><strong>Public link</strong>: a read-only link (<code>lixbon.com/s/…</code>) you can turn off whenever you want.</li>
        <li><strong>Lixbon CLI</strong>: copy the <code>/visual &lt;id&gt;</code> command and paste it into the CLI to turn the design into a real project (React + Vite, with an Express API if you ask for one).</li>
        <li><strong>Download</strong>: a <code>.zip</code> with the HTML pages (or the single file, if there&apos;s only one), and <strong>Copy code</strong> for the current page.</li>
      </ul>

      <Callout>
        Visuals is included in the <strong>Pro</strong> and <strong>Advance</strong>{' '}
        plans and draws from your plan&apos;s quota just like chat. On the Free plan
        you can browse the gallery, but not generate or edit designs.
      </Callout>
    </>
  );
}

function Cli({ base }) {
  return (
    <>
      <h1>CLI</h1>
      <p className="docs__lead">
        The lixbon CLI lets you chat with the cluster from the terminal and work
        with an agent that reads and edits your project, runs commands, and makes
        commits. Requires Python 3.10 or newer.
      </p>

      <h2>Install on Windows</h2>
      <p>Open <strong>PowerShell</strong> and run:</p>
      <CodeBlock code={`irm ${base}/install.ps1 | iex`} />
      <p>
        This downloads the CLI to <code>%USERPROFILE%\\.lixbon</code> and adds the{' '}
        <code>lixbon</code> command to your user PATH. Open a new terminal for the
        command to become available.
      </p>

      <h2>Install on Linux and macOS</h2>
      <p>Open your <strong>terminal</strong> and run:</p>
      <CodeBlock code={`curl -fsSL ${base}/install.sh | bash`} />
      <p>
        Installs the CLI to <code>~/.lixbon</code> and creates the{' '}
        <code>lixbon</code> command in <code>~/.local/bin</code>. If{' '}
        <code>lixbon</code> isn&apos;t recognized, add that folder to your PATH:
      </p>
      <CodeBlock code={`export PATH="$HOME/.local/bin:$PATH"`} />

      <h2>First run</h2>
      <p>
        Run <code>lixbon</code>: the first time, it opens interactive sign-in,
        with your email and password or by pasting an API key{' '}
        <code>lixbon_sk_…</code> (create one in{' '}
        <Link to="/account/profile">Settings → Account</Link>). Then pick a model
        and you&apos;re chatting. Type <code>/</code> to see every command.
      </p>
      <CodeBlock code={`lixbon`} />

      <h2>Modes</h2>
      <table className="docs__table">
        <thead><tr><th>Mode</th><th>What it does</th></tr></thead>
        <tbody>
          <tr><td><code>ask</code></td><td>Regular chat. Attach images with <code>@path.png</code> or <code>/paste</code>.</td></tr>
          <tr><td><code>agent</code></td><td>The model uses tools on your working folder: reads and edits files, runs commands, makes commits. Every tool asks for approval unless you turn on <code>/approve</code> or add it to <code>/allow</code>.</td></tr>
          <tr><td><code>plan</code></td><td>On top of agent mode: only explores and proposes a plan, without touching anything (<code>/plan on</code>).</td></tr>
          <tr><td><code>delegate</code></td><td>A classifier analyzes the request (intent, complexity, domain, risk) and routes it to whichever cluster model handles it best.</td></tr>
        </tbody>
      </table>
      <p>
        In <code>agent</code> and <code>plan</code> modes, the CLI asks for a high
        reasoning level from models that support it: an agent that thinks more
        makes fewer mistakes while editing.
      </p>

      <h2>Commands</h2>
      <table className="docs__table">
        <thead><tr><th>Command</th><th>What it does</th></tr></thead>
        <tbody>
          <tr><td><code>/model [name]</code></td><td>Switch models (no argument opens the picker)</td></tr>
          <tr><td><code>/mode [ask|agent|delegate]</code></td><td>Change working mode</td></tr>
          <tr><td><code>/new</code> · <code>/clear</code></td><td>Start a new conversation · clear the context</td></tr>
          <tr><td><code>/compact</code></td><td>Compact the conversation to free up context</td></tr>
          <tr><td><code>/history</code></td><td>View and reopen previous conversations</td></tr>
          <tr><td><code>/web [auto|on|off]</code></td><td>Web search: model decides, always, or never</td></tr>
          <tr><td><code>/image &lt;path&gt;</code> · <code>/paste</code></td><td>Attach an image from disk or the clipboard (Alt+V)</td></tr>
          <tr><td><code>/copy</code> · <code>/save [path]</code></td><td>Copy the last response · save the conversation as Markdown</td></tr>
          <tr><td><code>/plan [on|off]</code></td><td>Plan mode: the agent only explores and proposes</td></tr>
          <tr><td><code>/approve [on|off]</code></td><td>Auto-approve the agent&apos;s tools</td></tr>
          <tr><td><code>/allow [command]</code></td><td>Commands the agent runs without asking (npm test, pytest…)</td></tr>
          <tr><td><code>/todo</code> · <code>/tools</code></td><td>Agent&apos;s steps · available tools</td></tr>
          <tr><td><code>/diff [path]</code> · <code>/undo</code></td><td>Unconfirmed changes · revert the last turn&apos;s changes</td></tr>
          <tr><td><code>/run &lt;command&gt;</code> · <code>/ps</code></td><td>Run a command and feed the output to the model · background processes</td></tr>
          <tr><td><code>/check [on|off]</code></td><td>Lint every file the agent edits</td></tr>
          <tr><td><code>/commit [message]</code></td><td>Commit the changes with a message the model writes</td></tr>
          <tr><td><code>/workspace [path]</code> · <code>/init</code></td><td>Working folder · generate <code>LIXBON.md</code> with the project&apos;s context</td></tr>
          <tr><td><code>/mcp</code></td><td>Connected MCP servers and their tools</td></tr>
          <tr><td><code>/visual &lt;id or link&gt; [stack]</code></td><td>Pull a Visuals design and replicate it as a project (<code>react</code>, <code>react api</code>, or whatever stack you type)</td></tr>
          <tr><td><code>/remote</code></td><td>Control this session from your phone or the web (link + QR)</td></tr>
          <tr><td><code>/status</code> · <code>/cost</code> · <code>/usage</code></td><td>Session status · tokens used · account-wide usage</td></tr>
          <tr><td><code>/nodes</code></td><td>View the cluster&apos;s nodes</td></tr>
          <tr><td><code>/login</code> · <code>/logout</code> · <code>/key &lt;api_key&gt;</code></td><td>This machine&apos;s session</td></tr>
          <tr><td><code>/config</code> · <code>/bar</code> · <code>/doctor</code></td><td>Settings · status bar · terminal and connection diagnostics</td></tr>
          <tr><td><code>/update</code></td><td>Update the CLI to the latest version</td></tr>
        </tbody>
      </table>

      <h2>Replicate a Visuals design</h2>
      <p>
        In Visuals, <strong>Share → Lixbon CLI</strong> copies the command. In the CLI:
      </p>
      <CodeBlock code={`/visual 56f5bda7-… react api`} />
      <p>
        The CLI downloads the HTML pages to a folder, switches to agent mode, and
        sets up the project in <code>&lt;name&gt;-app/</code>: React 18 + Vite with
        one route per page, Tailwind via npm, and, with <code>api</code>, an
        Express server for the forms. Without a stack, it asks what to do with the
        design.
      </p>

      <h2>Manual install</h2>
      <p>
        If you&apos;d rather not run the script, download{' '}
        <a href={`${base}/install/client_cli.py`}>client_cli.py</a> and run it with Python:
      </p>
      <CodeBlock code={`python client_cli.py init --base-url ${base}/v1`} />
      <CodeBlock code={`python client_cli.py chat`} />
    </>
  );
}

function Desktop() {
  return (
    <>
      <h1>Desktop app</h1>
      <p className="docs__lead">
        The desktop app is a lightweight IDE with lixbon built in: an editor with
        autocomplete, chat and an agent on your project, for Windows, with
        automatic updates.
      </p>

      <h2>Install</h2>
      <p>
        Download the installer from <Link to="/apps">Apps</Link> and run it. Sign
        in with your email: the app creates and manages its own API key
        (&ldquo;lixbon Desktop&rdquo;), or you can sign in by pasting an existing key.
      </p>

      <h2>What&apos;s included</h2>
      <ul>
        <li><strong>Editor</strong> with syntax highlighting, find and replace, and <strong>ghost-text autocomplete</strong> (Copilot-style) served by the cluster&apos;s code model.</li>
        <li><strong>Chat</strong> with @-mentions for files in your project.</li>
        <li><strong>Agent</strong>: the same tools as the CLI (edit, run, commit) with step-by-step approval.</li>
        <li><strong>Remote</strong>: follow the session from your phone (<Link to="/docs/remote">see Remote</Link>).</li>
      </ul>

      <h2>Updates and channels</h2>
      <p>
        The app updates itself whenever we ship a new version: it notifies you and
        applies the signed update without reinstalling. There are two channels:{' '}
        <strong>stable</strong> (recommended) and <strong>beta</strong> (new
        versions early). Version history is at <Link to="/news">News</Link>.
      </p>

      <h2>Android app</h2>
      <p>
        <Link to="/apps">Apps</Link> also has the Android app (APK, Android 7.0 or
        newer): chat with your account and a Remote section to steer CLI or IDE
        sessions from your phone.
      </p>

      <Callout>
        If you don&apos;t see an installer in Apps yet, a version hasn&apos;t been
        published — in the meantime you can use the{' '}
        <Link to="/docs/cli">CLI</Link> or the{' '}
        <Link to="/chat">web chat</Link>.
      </Callout>
    </>
  );
}

function Remote() {
  return (
    <>
      <h1>Remote</h1>
      <p className="docs__lead">
        You&apos;re working with the agent in the CLI or the IDE and you have to
        step away. With <code>/remote</code> the session keeps running on your
        machine and you steer it from your phone or from any browser.
      </p>

      <h2>How to turn it on</h2>
      <ol>
        <li>In the CLI or the IDE, type <code>/remote</code>. No ports to open, nothing to configure.</li>
        <li>The session shows up in the <strong>Remote</strong> section of the Android app, and a <code>lixbon.com/remote/…</code> link is generated with a QR code for anyone without the app.</li>
        <li>From your phone or the web you see the live transcript, send new prompts, interrupt the turn, and respond to tool approvals.</li>
      </ol>

      <h2>Security</h2>
      <ul>
        <li>The link identifies the session, but it <strong>always requires signing in</strong> with the owning account: without your password, nobody gets in, even with the link.</li>
        <li>Everything runs on the originating machine: your phone is a remote control and never runs tools itself.</li>
        <li><code>/remote stop</code>, or closing the CLI or the IDE, ends the session and revokes the link.</li>
      </ul>

      <p>
        While signed in, <Link to="/remote">lixbon.com/remote</Link> lists your
        active sessions.
      </p>
    </>
  );
}

function ApiDocs({ base }) {
  return (
    <>
      <h1>API</h1>
      <p className="docs__lead">
        lixbon exposes an <strong>OpenAI-compatible</strong> API. If you already
        use the OpenAI SDK or any compatible client, just change the base URL and
        the API key.
      </p>

      <h2>Authentication</h2>
      <p>
        Create an API key in <Link to="/account/profile">Settings → Account</Link>.
        It&apos;s shown once when you create it; save it. Send it in the{' '}
        <code>Authorization</code> header:
      </p>
      <CodeBlock code={`Authorization: Bearer lixbon_sk_your_key`} />

      <h2>Base endpoint</h2>
      <CodeBlock code={`${base}/v1`} />

      <h2>List models</h2>
      <CodeBlock label="cURL" code={`curl ${base}/v1/models -H "Authorization: Bearer lixbon_sk_your_key"`} />
      <p>
        The <code>model</code> field is optional: if you don&apos;t send it, the
        gateway uses whatever model is assigned to the chat role.
      </p>

      <h2>Chat completions (streaming)</h2>
      <CodeBlock
        label="cURL"
        code={`curl ${base}/v1/chat/completions \\
  -H "Authorization: Bearer lixbon_sk_your_key" \\
  -H "Content-Type: application/json" \\
  -d '{"messages":[{"role":"user","content":"Hello"}],"stream":true}'`}
      />
      <p>
        The response arrives as <code>text/event-stream</code> events in the same
        format as OpenAI (<code>data: {'{...}'}</code> and <code>data: [DONE]</code>{' '}
        at the end). Without <code>stream</code>, the response is a complete JSON
        object with <code>usage</code>.
      </p>

      <h2>With the OpenAI SDK (Python)</h2>
      <CodeBlock
        label="Python"
        code={`from openai import OpenAI

client = OpenAI(base_url="${base}/v1", api_key="lixbon_sk_your_key")

stream = client.chat.completions.create(
    model="qwen3.5:27b",
    messages=[{"role": "user", "content": "Hello"}],
    stream=True,
)
for chunk in stream:
    print(chunk.choices[0].delta.content or "", end="")`}
      />

      <h2>Errors</h2>
      <table className="docs__table">
        <thead><tr><th>Code</th><th>Meaning</th></tr></thead>
        <tbody>
          <tr><td><code>401</code></td><td>Missing, revoked, or invalid API key.</td></tr>
          <tr><td><code>402 insufficient_credits</code></td><td>Out of credits: top up in <Link to="/account/billing">Billing</Link>.</td></tr>
          <tr><td><code>429</code></td><td>You went over your plan&apos;s requests per minute.</td></tr>
          <tr><td><code>503 model_not_available</code></td><td>No node is currently serving that model; try another from <code>/v1/models</code>.</td></tr>
        </tbody>
      </table>

      <Callout>
        API usage is paid with <strong>prepaid credits</strong> based on the
        tokens you consume: see <Link to="/docs/api-pricing">API pricing</Link>{' '}
        and the integration recipes in{' '}
        <Link to="/docs/using-your-api-key">Using your API key</Link>.
      </Callout>
    </>
  );
}

function UsingApiKey({ base }) {
  return (
    <>
      <h1>Using your API key</h1>
      <p className="docs__lead">
        Your <code>lixbon_sk_…</code> API key works in any tool compatible with
        the OpenAI API: official SDKs, AI-powered editors, agents, and your own
        scripts. Here are the most common recipes.
      </p>

      <h2>1. Create your key</h2>
      <p>
        Go to <Link to="/account/profile">Settings → Account → API keys</Link>{' '}
        and click &ldquo;New key&rdquo;. It&apos;s shown <strong>only once</strong>; save
        it in a secrets manager. If you lose it, revoke it and create another. How
        many keys you can have depends on your{' '}
        <Link to="/docs/plans">plan</Link>.
      </p>

      <h2>2. Add credits</h2>
      <p>
        Requests made with an API key are paid with{' '}
        <strong>prepaid credits</strong> based on the tokens you use (see{' '}
        <Link to="/docs/api-pricing">API pricing</Link>). Top up your balance in{' '}
        <Link to="/account/billing">Settings → Billing</Link>. Without a balance,
        the API responds with <code>402 insufficient_credits</code>.
      </p>

      <h2>The universal setup</h2>
      <p>Any OpenAI-compatible client only needs two values:</p>
      <table className="docs__table">
        <thead><tr><th>Parameter</th><th>Value</th></tr></thead>
        <tbody>
          <tr><td>Base URL</td><td><code>{base}/v1</code></td></tr>
          <tr><td>API key</td><td><code>lixbon_sk_your_key</code></td></tr>
        </tbody>
      </table>

      <h2>cURL</h2>
      <CodeBlock
        label="cURL"
        code={`curl ${base}/v1/chat/completions \\
  -H "Authorization: Bearer lixbon_sk_your_key" \\
  -H "Content-Type: application/json" \\
  -d '{"messages":[{"role":"user","content":"Hello"}]}'`}
      />

      <h2>Python (OpenAI SDK)</h2>
      <CodeBlock
        label="Python"
        code={`from openai import OpenAI

client = OpenAI(base_url="${base}/v1", api_key="lixbon_sk_your_key")

resp = client.chat.completions.create(
    messages=[{"role": "user", "content": "Hello"}],
)
print(resp.choices[0].message.content)`}
      />

      <h2>JavaScript / Node (OpenAI SDK)</h2>
      <CodeBlock
        label="JavaScript"
        code={`import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "${base}/v1",
  apiKey: "lixbon_sk_your_key",
});

const resp = await client.chat.completions.create({
  messages: [{ role: "user", content: "Hello" }],
});
console.log(resp.choices[0].message.content);`}
      />

      <h2>continue.dev (VS Code / JetBrains)</h2>
      <CodeBlock
        label="config.yaml"
        code={`models:
  - name: lixbon
    provider: openai
    model: qwen3.5:27b
    apiBase: ${base}/v1
    apiKey: lixbon_sk_your_key`}
      />

      <h2>Other tools</h2>
      <p>
        In any app that asks for an &ldquo;OpenAI-compatible provider&rdquo; (Open
        WebUI, LibreChat, aider, LangChain, LlamaIndex…), use the same base URL +
        key pair. List the available models with <code>GET {base}/v1/models</code>.
      </p>

      <Callout>
        See your detailed usage by day and model in{' '}
        <Link to="/account/usage">Settings → Usage</Link>, and the cost per model
        in <Link to="/docs/api-pricing">API pricing</Link>.
      </Callout>
    </>
  );
}

function ApiPricing() {
  const [pricing, setPricing] = useState(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    api.get('/api/pricing')
      .then((res) => setPricing(res.data.pricing))
      .catch(() => setError(true));
  }, []);

  const fmt = (v) => `$${v.toFixed(2)}`;

  return (
    <>
      <h1>API pricing</h1>
      <p className="docs__lead">
        Using the API with your key is paid with{' '}
        <strong>prepaid credits</strong>: you buy a balance once and every
        request deducts based on the real tokens it consumes, at that model&apos;s
        rate. No subscriptions, no surprises: if you don&apos;t use it, you don&apos;t
        spend it.
      </p>

      <h2>Rates by model</h2>
      <p>
        Prices in USD per <strong>million tokens</strong>. Credits can only be
        used on models in this table: a model with no published rate responds
        with <code>403 model_not_priced</code> instead of billing you at a price
        you don&apos;t know.
      </p>
      {error && (
        <p>Couldn&apos;t load rates right now. Try again in a few minutes.</p>
      )}
      {pricing === null && !error && <p>Loading rates…</p>}
      {pricing && (
        <table className="docs__table docs__table--tarifas">
          <thead>
            <tr><th>Model</th><th>API id</th><th className="num">Input</th><th className="num">Output</th></tr>
          </thead>
          <tbody>
            {pricing.map((p) => (
              <tr key={p.model_prefix}>
                <td>{p.display_name || p.model_prefix}</td>
                <td><code>{p.model_prefix}</code></td>
                <td className="num">{fmt(p.input_usd_per_mtok)}</td>
                <td className="num">{fmt(p.output_usd_per_mtok)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="docs__nota">Prices per million tokens. An id ending in <code>:</code> covers every variant of that family.</p>

      <h2>How cost is calculated</h2>
      <p>
        Every API response includes <code>usage</code> with input tokens (
        <code>prompt_tokens</code>) and output tokens (
        <code>completion_tokens</code>). The cost is:
      </p>
      <CodeBlock code={`cost = prompt_tokens × input_rate / 1,000,000
      + completion_tokens × output_rate / 1,000,000`} />
      <p>
        Example at the standard rate ($0.20 input / $0.60 output): a request with
        1,000 input tokens and 2,000 output tokens costs $0.0014. Cost is
        deducted when the response finishes, once the real token counts are known.
      </p>

      <h2>Top-up packs</h2>
      <table className="docs__table">
        <thead><tr><th>Pack</th><th>Price</th><th>Balance</th></tr></thead>
        <tbody>
          <tr><td>Starter</td><td>$5.00</td><td>$5.00 in credits</td></tr>
          <tr><td>Plus</td><td>$20.00</td><td>$20.00 in credits</td></tr>
          <tr><td>Power</td><td>$50.00</td><td>$50.00 in credits</td></tr>
        </tbody>
      </table>
      <ul>
        <li>Bought in <Link to="/account/billing">Settings → Billing</Link> with a card, as a one-time payment.</li>
        <li>Credits <strong>never expire</strong> and are only deducted for real API usage.</li>
        <li>Chat from the web, the app, and Visuals with your session does <strong>not</strong> consume credits: it runs on your plan.</li>
        <li>With <strong>auto-recharge</strong>, the pack you choose is charged automatically when your balance drops below $5 (see <Link to="/docs/billing">Billing</Link>).</li>
      </ul>

      <h2>Out of balance</h2>
      <p>
        When your balance hits zero, the API responds with <code>402</code> and{' '}
        <code>insufficient_credits</code>, along with your current balance. Top up
        and the key works again instantly; keys are never blocked for any other
        payment reason.
      </p>

      <Callout>
        Your detailed usage (tokens and cost by day and model) is always visible
        in <Link to="/account/usage">Settings → Usage</Link>.
      </Callout>
    </>
  );
}

function Plans() {
  return (
    <>
      <h1>Plans and limits</h1>
      <p className="docs__lead">
        Every account has a plan that sets how many messages and tokens you can
        use with your session (web, app, CLI, Visuals), how many API keys you can
        have, and how many requests per minute the API allows.
      </p>

      <h2>The three plans</h2>
      <table className="docs__table">
        <thead>
          <tr><th>Plan</th><th>Price</th><th>Messages/day</th><th>Tokens/month</th><th>API keys</th><th>Requests/min</th><th>Visuals</th></tr>
        </thead>
        <tbody>
          <tr><td><strong>Free</strong></td><td>$0</td><td>30</td><td>150,000</td><td>1</td><td>10</td><td>No</td></tr>
          <tr><td><strong>Pro</strong></td><td>$9.90 / mo</td><td>500</td><td>5,000,000</td><td>5</td><td>60</td><td>Yes</td></tr>
          <tr><td><strong>Advance</strong></td><td>$24.90 / mo</td><td>Unlimited</td><td>20,000,000</td><td>20</td><td>120</td><td>Yes</td></tr>
        </tbody>
      </table>
      <p>
        Every plan has access to every active model on the cluster. Current
        prices and plan changes live on the <Link to="/plans">Plans</Link> page.
      </p>

      <h2>How limits are counted</h2>
      <ul>
        <li><strong>Messages per day</strong> reset every day at midnight (UTC).</li>
        <li><strong>Tokens per month</strong> reset on the 1st of each month.</li>
        <li>You can watch your usage in real time in <Link to="/account/usage">Settings → Usage</Link>.</li>
      </ul>

      <h2>When you hit a limit</h2>
      <p>
        If you go over quota, the platform tells you clearly and shows when it
        resets. To raise the limit, upgrade your plan: the change applies
        instantly, and today you&apos;re only charged the prorated difference (see{' '}
        <Link to="/docs/billing">Billing</Link>).
      </p>

      <h2>What about the API?</h2>
      <p>
        Requests made with an API key <strong>don&apos;t</strong> draw from your
        plan&apos;s quota: they&apos;re paid with{' '}
        <Link to="/docs/api-pricing">prepaid credits</Link> per token and can use
        any model on the cluster. Only the requests-per-minute limit and the
        number of keys carry over from your plan.
      </p>
    </>
  );
}

function Billing() {
  return (
    <>
      <h1>Billing and payments</h1>
      <p className="docs__lead">
        Everything is managed in <Link to="/account/billing">Settings → Billing</Link>:
        your plan, cards, charges, invoices, and API credits. Payments are
        processed by <strong>Stripe</strong>; your card number never passes
        through lixbon.
      </p>

      <h2>Subscribing to a plan</h2>
      <ol>
        <li>In <Link to="/plans">Plans</Link>, choose Pro or Advance. Payment opens without leaving lixbon.</li>
        <li>Pick a saved card or add a new one (the form is served by Stripe).</li>
        <li>If your bank asks for confirmation (3-D Secure), its window opens; complete it there.</li>
        <li>The plan is active instantly, and you get an email with the details. It renews every month on the same card.</li>
      </ol>

      <h2>Changing plans</h2>
      <ul>
        <li><strong>Upgrading</strong> (Pro → Advance): today you&apos;re only charged the prorated difference for the month; from the next renewal you pay full price. If your bank asks for confirmation, the change applies once you confirm.</li>
        <li><strong>Downgrading</strong> (Advance → Pro): nothing is charged today; whatever you&apos;ve prepaid on the pricier plan is deducted from future invoices. The new plan&apos;s limits apply right away.</li>
      </ul>

      <h2>Canceling and reactivating</h2>
      <p>
        <strong>Canceling</strong> keeps your plan active until the end of the
        paid period and doesn&apos;t renew it; after that you move to Free. Until
        that date you can <strong>reactivate</strong> with one click and it starts
        renewing again. There are no refunds for periods already paid.
      </p>

      <h2>If a charge fails</h2>
      <p>
        If a renewal doesn&apos;t go through, you get an email with the amount, a
        link to pay the invoice or change your card, and the date of the next
        attempt. Stripe retries for a few days and the plan stays active in the
        meantime; if every attempt fails, the subscription is canceled and you
        move to the Free plan.
      </p>

      <h2>Cards</h2>
      <ul>
        <li>You can save several cards and pick a <strong>default</strong> one, which is what the plan renews on.</li>
        <li>The only card on an active subscription can&apos;t be removed: add another one first.</li>
        <li>If you remove the auto-recharge card, auto-recharge turns off.</li>
        <li>Cards are stored in Stripe via a SetupIntent: lixbon only knows the brand, the last four digits, and the expiration date.</li>
      </ul>

      <h2>Charges and invoices</h2>
      <p>
        In Billing you can see your recent charges (renewals, plan changes, and
        top-ups) with their receipts, and your subscription invoices as PDFs.
      </p>

      <h2>API credits</h2>
      <ul>
        <li><strong>Add credits</strong>: pick a pack (Starter, Plus, or Power) and pay with a saved card or a new one. If you don&apos;t check &ldquo;save&rdquo;, the card is dropped once the charge closes.</li>
        <li><strong>Auto-recharge</strong>: when your balance drops below $5, the pack you chose is charged to the card you chose, automatically. If the charge fails, auto-recharge turns off and we email you.</li>
        <li>Every movement (a top-up, or usage per request, with model and token counts) is logged in your credit history.</li>
      </ul>

      <h2>Security</h2>
      <p>
        Card fields are iframes served by Stripe: the card number never touches
        lixbon&apos;s domain or servers. Every charge is confirmed two ways
        (Stripe&apos;s response and its webhook) and is idempotent, so you&apos;re
        never charged or credited twice.
      </p>

      <Callout>
        Full terms are in{' '}
        <Link to="/legal/refunds">Cancellations and refunds</Link> and in the{' '}
        <Link to="/legal/terms">Terms</Link>.
      </Callout>
    </>
  );
}

function Privacy() {
  return (
    <>
      <h1>Privacy and data</h1>
      <p className="docs__lead">
        What lixbon stores, why, and how you control it from{' '}
        <Link to="/account/privacy">Settings → Privacy</Link>.
      </p>

      <h2>What&apos;s stored</h2>
      <ul>
        <li><strong>Account</strong>: email, name, and password (hashed).</li>
        <li><strong>Conversations and designs</strong>, if history is turned on, so you can pick them back up.</li>
        <li><strong>Usage</strong>: messages and tokens per day, to enforce plan limits and show you your consumption.</li>
        <li><strong>Billing</strong>: your Stripe customer id, your plan, and your credit balance. Never your card number.</li>
      </ul>

      <h2>Privacy settings</h2>
      <ul>
        <li><strong>Anonymous usage data</strong>: aggregated metrics to improve the service.</li>
        <li><strong>Conversation history</strong>: turned off, new chats aren&apos;t saved (usage is still counted).</li>
      </ul>

      <h2>Your data</h2>
      <ul>
        <li><strong>Export</strong>: download a copy of your data as JSON.</li>
        <li><strong>Delete history</strong>: removes every conversation; aggregate usage is kept.</li>
        <li><strong>Delete account</strong>: deletes the account and all its data. Asks for your password; if you have a paid plan, the subscription is canceled in Stripe at that moment.</li>
      </ul>

      <h2>Public links</h2>
      <p>
        A conversation or a design is only visible to others once you create its
        public link; you can stop sharing it whenever you want and the link stops
        working instantly.
      </p>

      <Callout>
        The full text is in the{' '}
        <Link to="/legal/privacy">Privacy policy</Link>; the service&apos;s terms
        are in the <Link to="/legal/terms">Terms</Link>.
      </Callout>
    </>
  );
}

const CUERPOS = {
  introduction: Introduction,
  'getting-started': GettingStarted,
  chat: WebChat,
  visuals: Visuals,
  cli: Cli,
  desktop: Desktop,
  remote: Remote,
  api: ApiDocs,
  'using-your-api-key': UsingApiKey,
  'api-pricing': ApiPricing,
  plans: Plans,
  billing: Billing,
  privacy: Privacy,
};

export { CUERPOS };
