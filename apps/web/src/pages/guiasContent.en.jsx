// guiasContent.en.jsx — English articles for /guides. Each one answers a
// specific search and only describes what lixbon actually does.
import { Link } from '../i18n/link';
import { CodeBlock } from '../components/CodeBlock';

const BASE = 'https://lixbon.com';

function ApiCompatible() {
  return (
    <>
      <p className="docs__lead">
        Almost every AI tool (SDKs, editors, agents, LangChain, Open WebUI)
        speaks the OpenAI API “dialect.” lixbon being compatible means you
        don’t have to learn another one: change two values and your code talks
        to our models.
      </p>

      <h2>What “OpenAI-compatible” means</h2>
      <p>
        We accept the same routes (<code>/v1/models</code>, <code>/v1/chat/completions</code>),
        the same message format (<code>role</code> and <code>content</code>), the
        same event streaming, and the same <code>usage</code> field with the
        tokens consumed. Any client that lets you set a “base URL” and an
        “API key” works.

      </p>

      <h2>1. Get your key</h2>
      <p>
        Create an account, go to <Link to="/account/profile">Settings → Account → API keys</Link>, and
        click “New key.” It starts with <code>lixbon_sk_</code> and is shown
        only once. Top up some credits in <Link to="/account/billing">Billing</Link>: the
        API is paid per token, not by subscription (the smallest pack is $5).
      </p>

      <h2>2. The two values</h2>
      <table className="docs__table">
        <thead><tr><th>Parameter</th><th>Value</th></tr></thead>
        <tbody>
          <tr><td>Base URL</td><td><code>{BASE}/v1</code></td></tr>
          <tr><td>API key</td><td><code>lixbon_sk_your_key</code></td></tr>
        </tbody>
      </table>

      <h2>3. First call with cURL</h2>
      <CodeBlock label="cURL" code={`curl ${BASE}/v1/chat/completions \\
  -H "Authorization: Bearer lixbon_sk_your_key" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"lixbon-1","messages":[{"role":"user","content":"Explain what a token is in two sentences"}]}'`} />
      <p>
        <code>model</code> is optional: without it we use the default chat
        model. Use <code>GET /v1/models</code> to see what’s available;{' '}
        <code>lixbon-1</code> is Qwen 3.5 27B.
      </p>

      <h2>4. Python</h2>
      <CodeBlock label="Python" code={`pip install openai

from openai import OpenAI

client = OpenAI(base_url="${BASE}/v1", api_key="lixbon_sk_your_key")

resp = client.chat.completions.create(
    model="lixbon-1",
    messages=[
        {"role": "system", "content": "Answer in English, briefly."},
        {"role": "user", "content": "What is an embedding?"},
    ],
)
print(resp.choices[0].message.content)
print(resp.usage.prompt_tokens, resp.usage.completion_tokens)`} />

      <h2>5. JavaScript</h2>
      <CodeBlock label="JavaScript" code={`import OpenAI from "openai";

const client = new OpenAI({ baseURL: "${BASE}/v1", apiKey: "lixbon_sk_your_key" });

const stream = await client.chat.completions.create({
  model: "lixbon-1",
  messages: [{ role: "user", content: "Give me three names for a coffee shop" }],
  stream: true,
});
for await (const chunk of stream) {
  process.stdout.write(chunk.choices[0]?.delta?.content ?? "");
}`} />

      <h2>6. Errors you’ll run into (and what to do)</h2>
      <table className="docs__table">
        <thead><tr><th>Code</th><th>What it means</th><th>Fix</th></tr></thead>
        <tbody>
          <tr><td><code>401</code></td><td>Missing or revoked key</td><td>Generate another one in Settings</td></tr>
          <tr><td><code>402 insufficient_credits</code></td><td>No balance</td><td>Top up in Billing</td></tr>
          <tr><td><code>403 model_not_priced</code></td><td>That model has no published rate</td><td>Use one from <Link to="/docs/api-pricing">the table</Link></td></tr>
          <tr><td><code>429</code></td><td>Too many requests per minute</td><td>Wait, or upgrade your plan</td></tr>
          <tr><td><code>503 model_not_available</code></td><td>No node is serving that model right now</td><td>Try another from <code>/v1/models</code></td></tr>
        </tbody>
      </table>

      <h2>7. How much it costs</h2>
      <p>
        Every response includes <code>usage</code>. With Lixbon 1 ($0.40 per
        million input tokens and $1.20 output), a call with 500 input tokens
        and 300 output tokens costs $0.00056. With $5 in credits you get about
        nine thousand calls like that. Every model’s prices are in{' '}
        <Link to="/docs/api-pricing">API pricing</Link>, and your daily usage
        in <Link to="/account/usage">Settings → Usage</Link>.
      </p>
    </>
  );
}

function QwenPython() {
  return (
    <>
      <p className="docs__lead">
        Qwen 3.5 is one of the best open models for coding and general use. On
        lixbon you get it as <code>lixbon-1</code> (the 27-billion-parameter
        version) with nothing to install: call it from Python just like any
        OpenAI API.
      </p>

      <h2>Setup</h2>
      <CodeBlock label="Terminal" code={`pip install openai
export LIXBON_API_KEY=lixbon_sk_your_key   # on Windows: set LIXBON_API_KEY=...`} />
      <p>
        You create the key in <Link to="/account/profile">Settings → Account</Link>; credits,
        in <Link to="/account/billing">Billing</Link>.
      </p>

      <h2>Basic call</h2>
      <CodeBlock label="Python" code={`import os
from openai import OpenAI

client = OpenAI(base_url="${BASE}/v1", api_key=os.environ["LIXBON_API_KEY"])

def ask(text):
    resp = client.chat.completions.create(
        model="lixbon-1",
        messages=[{"role": "user", "content": text}],
    )
    return resp.choices[0].message.content

print(ask("Summarize in one sentence what the requests library does"))`} />

      <h2>A system prompt that actually does something</h2>
      <p>
        Qwen follows system instructions well. Use them to set language, tone
        and format instead of repeating it in every message:
      </p>
      <CodeBlock label="Python" code={`SYSTEM = (
    "You are a technical assistant. Answer in English, no fluff, "
    "with code examples when they help. If you don't know something, say so."
)

resp = client.chat.completions.create(
    model="lixbon-1",
    messages=[
        {"role": "system", "content": SYSTEM},
        {"role": "user", "content": "How do I read a large CSV without loading it all into memory?"},
    ],
    temperature=0.3,
)`} />

      <h2>Streaming (so the user isn’t left waiting)</h2>
      <CodeBlock label="Python" code={`stream = client.chat.completions.create(
    model="lixbon-1",
    messages=[{"role": "user", "content": "Write a haiku about Medellín"}],
    stream=True,
)
for chunk in stream:
    print(chunk.choices[0].delta.content or "", end="", flush=True)`} />

      <h2>JSON responses</h2>
      <p>
        Ask for the format in the prompt and validate with <code>json.loads</code>;
        Qwen 3.5 follows it reliably if you give it an example:
      </p>
      <CodeBlock label="Python" code={`import json

resp = client.chat.completions.create(
    model="lixbon-1",
    messages=[
        {"role": "system", "content": 'Respond with JSON ONLY: {"sentiment": "positive|neutral|negative", "reason": "..."}'},
        {"role": "user", "content": "The shipment arrived late but the product is excellent."},
    ],
    temperature=0,
)
data = json.loads(resp.choices[0].message.content)
print(data["sentiment"])`} />

      <h2>How much each call costs</h2>
      <p>
        <code>resp.usage</code> gives you the real token counts. At Lixbon 1’s rate:
      </p>
      <CodeBlock label="Python" code={`INPUT, OUTPUT = 0.40, 1.20   # USD per million tokens
u = resp.usage
cost = (u.prompt_tokens * INPUT + u.completion_tokens * OUTPUT) / 1_000_000
print(f"{cost:.6f} USD")   # a typical response runs about five ten-thousandths of a dollar`} />

      <h2>When to use a different model</h2>
      <ul>
        <li>For simple, highly repetitive tasks (classifying, extracting fields), a small model like <code>qwen3:4b</code> costs five times less.</li>
        <li>For long reasoning or hard debugging, check whether a large model is active at <code>/v1/models</code> (for example Qwen 3.5 122B or gpt-oss 120B).</li>
        <li>Current rates are always at <Link to="/docs/api-pricing">API pricing</Link>.</li>
      </ul>
    </>
  );
}

function AgenteTerminal() {
  return (
    <>
      <p className="docs__lead">
        The lixbon CLI isn’t just terminal chat: in agent mode, the model
        reads your project, proposes changes, applies them with your
        permission, runs the tests, and makes the commit. This guide takes
        you from zero to a first reviewed change.
      </p>

      <h2>1. Install the CLI</h2>
      <CodeBlock label="PowerShell (Windows)" code={`irm ${BASE}/install.ps1 | iex`} />
      <CodeBlock label="bash (Linux and macOS)" code={`curl -fsSL ${BASE}/install.sh | bash`} />
      <p>
        Open a new terminal, run <code>lixbon</code>, and sign in with your
        email and password (or an API key). You need Python 3.10 or newer.
      </p>

      <h2>2. Get into your project</h2>
      <p>
        The agent works on the working folder. Open the CLI inside the
        project, or set it with <code>/workspace path</code>. With{' '}
        <code>/init</code> the model generates a <code>LIXBON.md</code> with
        the project’s context (stack, how it runs, how it’s tested) that gets
        included in every turn.
      </p>

      <h2>3. Start in plan mode</h2>
      <CodeBlock label="lixbon" code={`/mode agent
/plan on
I want to add pagination to the /api/orders endpoint. Check how it's built and propose a plan.`} />
      <p>
        In plan mode the agent only reads and proposes: nothing gets touched.
        It’s the safe way to get to know an unfamiliar codebase, or to
        validate an approach before spending tokens editing.
      </p>

      <h2>4. Let it edit, with approval</h2>
      <CodeBlock label="lixbon" code={`/plan off
Apply the plan.`} />
      <p>
        Every edit shows up as a diff (<code>● Update(file) +N -M</code>) and
        asks you to approve it: <strong>Yes</strong>, <strong>Yes, and don’t
        ask again</strong>, or <strong>No</strong>. Read-only tools don’t ask.
        If you regret an entire turn, <code>/undo</code> reverts what it touched.
      </p>

      <h2>5. Frictionless testing</h2>
      <CodeBlock label="lixbon" code={`/allow pytest
/allow npm test
/check on`} />
      <p>
        <code>/allow</code> lets the agent run those commands without asking
        every time; <code>/check on</code> runs the linter on every file it
        edits and feeds it the errors so it can fix them itself. With{' '}
        <code>/run command</code> you give it any command’s output as context.
      </p>

      <h2>6. Review and commit</h2>
      <CodeBlock label="lixbon" code={`/diff
/commit`} />
      <p>
        <code>/diff</code> shows the unconfirmed changes; <code>/commit</code>{' '}
        writes the message from them and commits. If you’d rather write your
        own message: <code>/commit "feat: pagination on /api/orders"</code>.
      </p>

      <h2>Tips that save tokens and headaches</h2>
      <ul>
        <li>Ask for one thing per turn. “Add pagination” works better than “add pagination, change the logger, and update the README.”</li>
        <li>When the context grows, <code>/compact</code> summarizes it and keeps going with just enough memory; <code>/cost</code> tells you how much you’ve used.</li>
        <li>In agent and plan modes the CLI requests high reasoning from models that support it: they think more and make fewer mistakes while editing.</li>
        <li>Have to step away? <code>/remote</code> gives you a link and a QR code to follow the session and approve changes from your phone.</li>
        <li>If you designed something in <Link to="/docs/visuals">Visuals</Link>, <code>/visual &lt;id&gt; react api</code> turns it into a React + Vite project with an API.</li>
      </ul>
      <p>
        The full command list is in the <Link to="/docs/cli">CLI documentation</Link>.
      </p>
    </>
  );
}

function DatosPrivados() {
  return (
    <>
      <p className="docs__lead">
        When you type into an AI chat, your text travels to someone’s
        servers. The useful question isn’t “is it safe?” but “where does it
        go, who stores it, and for what?” This guide answers that for
        lixbon, plainly.
      </p>

      <h2>Where what you type goes</h2>
      <p>
        On lixbon, your message reaches our server and from there a GPU we
        control (owned, or rented by the hour). The model generates the
        response and the GPU keeps nothing. There’s no third-party AI
        provider in the middle: no calls go to OpenAI, Google, or Anthropic.
      </p>

      <h2>What’s stored and what isn’t</h2>
      <ul>
        <li><strong>Stored</strong>: your conversation, if history is on, so you can pick it back up. And how much you use (messages and tokens), to enforce plan limits.</li>
        <li><strong>Not stored</strong>: nothing on the GPU nodes, your content is never used to train models, and it’s never shared for commercial purposes.</li>
        <li>If you turn off “Conversation history” in <Link to="/account/privacy">Settings → Privacy</Link>, new chats aren’t saved; usage is still counted.</li>
      </ul>

      <h2>What controls you have</h2>
      <ul>
        <li><strong>Export</strong> all your data as JSON, in one click.</li>
        <li><strong>Delete your entire history</strong> whenever you want.</li>
        <li><strong>Delete your account</strong>: everything of yours is removed and the subscription is cancelled on the spot.</li>
        <li><strong>Public links</strong>: a conversation or a design is only visible to others if you create the link, and you can turn it off instantly.</li>
      </ul>

      <h2>What’s different from a service like ChatGPT</h2>
      <table className="docs__table">
        <thead><tr><th></th><th>A big provider’s service</th><th>lixbon</th></tr></thead>
        <tbody>
          <tr><td>Where the model runs</td><td>In the provider’s cloud</td><td>On GPUs we control</td></tr>
          <tr><td>Models</td><td>Closed, the provider’s own</td><td>Open (Qwen, DeepSeek, gpt-oss)</td></tr>
          <tr><td>Used for training</td><td>Depends on plan and settings</td><td>Never</td></tr>
          <tr><td>History</td><td>Configurable</td><td>Configurable, exportable and deletable</td></tr>
          <tr><td>API pricing</td><td>Per token, provider’s rates</td><td>Per token, published rates, credits that never expire</td></tr>
        </tbody>
      </table>
      <p>
        What you won’t find here is the biggest model in the world: we use
        open models that fit on real GPUs. For most tasks (writing,
        summarizing, coding, designing) the difference is small; for tasks
        that need very long reasoning, pick the large model when it’s active.
      </p>

      <h2>For companies and sensitive data</h2>
      <p>
        If your case requires that data never leave your own infrastructure,
        write to us at{' '}
        <a href="mailto:soporte@lixbon.com">soporte@lixbon.com</a>: lixbon’s
        architecture (gateway + GPU nodes) allows deploying the nodes on your
        own hardware.
      </p>
      <p>
        The legal details are in the <Link to="/legal/privacy">Privacy policy</Link>.
      </p>
    </>
  );
}

const CUERPOS = {
  'openai-compatible-api': ApiCompatible,
  'qwen-3-5-python': QwenPython,
  'cli-agent-mode': AgenteTerminal,
  'private-data-own-gpus': DatosPrivados,
};

export { CUERPOS };
