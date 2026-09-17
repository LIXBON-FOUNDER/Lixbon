// legalContent.en.jsx — English legal text for lixbon (/legal/:doc). This is
// a translation of legalContent.es.jsx; RESPONSABLE/VIGENCIA come from
// legalShared.js so both language versions stay in sync on the facts.
import { Link } from '../i18n/link';
import { RESPONSABLE, VIGENCIA as VIGENCIA_POR_IDIOMA } from './legalShared';

const VIGENCIA = VIGENCIA_POR_IDIOMA.en;

function Privacidad() {
  return (
    <>
      <h1>Privacy policy</h1>
      <p className="docs__lead">
        Here’s a plain explanation of what personal data lixbon stores about
        you, what we use it for, who we share it with, and how you can ask us
        to change or delete it. It applies to the web, the apps and the API,
        and follows Colombian data protection law (Law 1581 of 2012).
      </p>

      <h2>Who is responsible for your data</h2>
      <p>
        {RESPONSABLE.nombre} ({RESPONSABLE.nit}), located at {RESPONSABLE.direccion}.
        For any question about your data, write to us at{' '}
        <a href={`mailto:${RESPONSABLE.correo}`}>{RESPONSABLE.correo}</a>.
      </p>

      <h2>What data we store</h2>
      <ul>
        <li><strong>Your account:</strong> first name, last name, email and password. The password is stored hashed, so even we can’t read it.</li>
        <li><strong>What you write:</strong> your conversations, the files you attach, the designs you make in Visuals, and the code you share with the agent. It’s only stored if you have history turned on; if you turn it off, new chats aren’t recorded.</li>
        <li><strong>How much you use lixbon:</strong> how many messages and tokens you use each day, and with which model. We use this to enforce your plan’s limits, show you your usage, and bill API usage.</li>
        <li><strong>Payments:</strong> your plan, your Stripe customer id, the brand and last four digits of your cards, your charges and your credit balance. Your full card number never reaches lixbon: Stripe receives it directly from your browser.</li>
        <li><strong>Technical data:</strong> the IP address and browser you sign in with, and a log of important actions (changing your password, paying, deleting data) in case we ever need to clarify what happened.</li>
        <li><strong>API keys:</strong> each key’s name and what it consumes. The key itself is shown only once and is stored hashed.</li>
      </ul>

      <h2>What we use it for</h2>
      <ul>
        <li>To make lixbon work: recognizing you when you sign in, responding to your messages, saving your history and your designs.</li>
        <li>To manage your plan and bill you, and to email you when something happens with a payment (sign-up, renewal, failed charge, cancellation).</li>
        <li>To enforce your plan’s limits and curb abuse.</li>
        <li>To handle your support messages and your requests about your data.</li>
        <li>To improve the service with anonymous statistics, only if you leave the “Anonymous usage data” option on in Settings.</li>
        <li>To meet the legal, accounting and tax obligations that apply to us.</li>
      </ul>
      <p>
        Your conversations and your designs are yours. <strong>We don’t use
        them to train models</strong>, we don’t sell them, and we don’t hand
        them to anyone for commercial purposes.
      </p>

      <h2>Who we share data with</h2>
      <p>
        To operate, lixbon relies on a few providers. They only receive what
        they need to do their part, and several of them are outside Colombia:
      </p>
      <ul>
        <li><strong>Railway</strong> (United States): hosts the server and the database.</li>
        <li><strong>Stripe</strong> (United States): processes payments and stores your cards. Its privacy policy is at <a href="https://stripe.com/privacy" target="_blank" rel="noreferrer">stripe.com/privacy</a>.</li>
        <li><strong>GPU servers</strong>, owned or rented (for example, on Vast.ai): the models run there. Your messages pass through them only for as long as it takes to generate the response, and aren’t kept there.</li>
        <li><strong>Cloudflare</strong>: protects and speeds up access to lixbon.com.</li>
        <li><strong>An email service</strong>: sends verification, password reset and payment emails.</li>
      </ul>
      <p>
        By accepting this policy you authorize us to send your data to those
        providers, who are contractually required to protect it. Beyond them,
        we would only hand over data if required by an authority with the
        power to demand it.
      </p>

      <h2>How long we keep it</h2>
      <ul>
        <li>Your account, your history and your designs, for as long as you have an account. You can delete your history whenever you want.</li>
        <li>Payment data and the action log, for as long as accounting and tax law requires, even if you delete your account.</li>
        <li>If you delete your account, we remove your conversations, designs, keys and profile data, and cancel your subscription in Stripe at that moment.</li>
      </ul>

      <h2>Your rights</h2>
      <p>
        You can view, correct and delete your data, withdraw the authorization
        you gave us, ask us for a copy of it, and, if you feel we haven’t
        handled something well, file a complaint with Colombia’s data
        protection authority (Superintendencia de Industria y Comercio). You
        can do almost all of this yourself from{' '}
        <Link to="/account/privacy">Settings → Privacy</Link>: download your
        data, delete your history, or delete your account. For anything else,
        write to us at{' '}
        <a href={`mailto:${RESPONSABLE.correo}`}>{RESPONSABLE.correo}</a>: we
        answer inquiries within ten business days at most, and complaints
        within fifteen.
      </p>

      <h2>How we protect it</h2>
      <ul>
        <li>Everything that travels between your device and lixbon is encrypted.</li>
        <li>Passwords and API keys are stored so they can’t be read, even from the inside.</li>
        <li>Your card details are entered into a form served by Stripe: they never pass through our servers.</li>
        <li>A conversation or a design can only be seen from outside if you create its public link, and you can turn it off instantly.</li>
        <li>Access to the admin panel is restricted and logged.</li>
      </ul>

      <h2>Cookies</h2>
      <p>
        We use a single cookie, the one that keeps your session signed in, and
        browser storage to remember your interface preferences. There are no
        advertising or tracking cookies.
      </p>

      <h2>Minors</h2>
      <p>
        lixbon is for people 18 and older. If we find an account belonging to
        a minor without their parents’ or guardians’ permission, we’ll delete it.
      </p>

      <h2>Changes to this policy</h2>
      <p>
        If we change it, we’ll tell you by email or inside the app ahead of
        time. This version has been in effect since {VIGENCIA}.
      </p>
    </>
  );
}

function Terminos() {
  return (
    <>
      <h1>Terms and conditions</h1>
      <p className="docs__lead">
        By creating an account you accept these terms. They’re written to be
        understood: what we offer you, what we expect from you, and where our
        liability ends.
      </p>

      <h2>What lixbon is</h2>
      <p>
        An AI platform with chat, website design (Visuals), coding tools (CLI
        and desktop app), session control from your phone (Remote), and an
        OpenAI-compatible API. It’s offered by{' '}
        {RESPONSABLE.nombre} ({RESPONSABLE.nit}), located at {RESPONSABLE.direccion}.
      </p>

      <h2>Your account</h2>
      <ul>
        <li>You must be 18 or older and give us real information.</li>
        <li>Your password and your API keys are your responsibility. If you think someone else has them, change or revoke them from Settings.</li>
        <li>The account is yours alone: don’t share it or resell it.</li>
      </ul>

      <h2>Plans, limits and payments</h2>
      <ul>
        <li>Each plan has the limits you see on <Link to="/plans">Plans</Link> and in the <Link to="/docs/plans">documentation</Link>. If we change prices or limits, we’ll tell you beforehand, and the change will apply from your next renewal.</li>
        <li>Paid plans are billed monthly in advance, to the card you register, through Stripe. They renew automatically until you cancel.</li>
        <li>If you upgrade, you’re only charged today for the remaining days of the month, prorated. If you downgrade, you pay nothing and whatever is left over is deducted from upcoming invoices.</li>
        <li>Using the API with a key is paid with credits you buy in advance, based on the tokens you consume and the <Link to="/docs/api-pricing">published prices</Link>. Only the models listed in that table are billed.</li>
        <li>Prices are in US dollars. Taxes may apply depending on your country.</li>
        <li>If a charge fails, Stripe retries it for a few days. If it never goes through, the subscription is cancelled and your account moves to the Free plan.</li>
        <li>What happens when you cancel or want a refund is covered in <Link to="/legal/refunds">Cancellations and refunds</Link>.</li>
      </ul>

      <h2>What you can’t do</h2>
      <ul>
        <li>Use lixbon for illegal activities, to harass anyone, or to generate content that exploits minors, incites violence, or violates others’ rights.</li>
        <li>Create malicious software, attack other systems, or work around the service’s limits (for example, by splitting usage across several accounts).</li>
        <li>Resell access, or scrape responses at scale in an automated way.</li>
      </ul>
      <p>
        If someone breaks these rules we may suspend or close their account.
        Whenever possible, we’ll warn them first.
      </p>

      <h2>Who owns what</h2>
      <ul>
        <li>What you send (messages, files, code, designs) remains yours. You only grant us permission to process and store it in order to provide the service.</li>
        <li>The responses and designs you generate are also yours, within what the licenses of the open-source models that produce them allow.</li>
        <li>The lixbon brand, the software and the interface belong to {RESPONSABLE.nombre}.</li>
      </ul>

      <h2>What the AI generates</h2>
      <p>
        The models make mistakes: they can invent facts or write code with
        bugs. What they generate is provided as-is, with no guarantee that
        it’s correct, and it isn’t legal, medical or financial advice. Review
        it before using it, especially if you’re going to run code or make
        decisions based on it. In the CLI’s and desktop app’s agent mode, the
        model edits files and runs commands on your machine with your
        approval: deciding what to approve is up to you.
      </p>

      <h2>Availability</h2>
      <p>
        We do our best to keep lixbon available at all times, but we depend on
        others (the cloud, rented GPUs, the payment gateway), and there can be
        outages due to maintenance or incidents. The plans don’t include a
        guaranteed-availability commitment.
      </p>

      <h2>Liability</h2>
      <p>
        To the extent the law allows, lixbon isn’t liable for indirect
        damages, lost revenue, or lost data arising from using the service or
        from it going down. If we were ever found liable, the cap would be
        whatever you paid in the previous three months. None of this reduces
        the rights Colombian consumer law gives you.
      </p>

      <h2>Closing your account</h2>
      <p>
        You can delete your account whenever you want from Settings →
        Privacy. We may close it if you break these terms or if we stop
        offering the service; in that case we’ll give you advance notice and
        apply the refund policy to whatever you’ve paid in advance.
      </p>

      <h2>Governing law and contact</h2>
      <p>
        These terms are governed by the laws of Colombia. If you have
        questions, write to us at{' '}
        <a href={`mailto:${RESPONSABLE.soporte}`}>{RESPONSABLE.soporte}</a>. In
        effect since {VIGENCIA}.
      </p>
    </>
  );
}

function Reembolsos() {
  return (
    <>
      <h1>Cancellations and refunds</h1>
      <p className="docs__lead">
        What happens to your money when you cancel, change plans, or a charge
        goes wrong.
      </p>

      <h2>Cancelling your plan</h2>
      <ul>
        <li>Cancel whenever you want from <Link to="/account/billing">Settings → Billing</Link>. No calls, no emails.</li>
        <li>The plan stays active until the end of the month you already paid for. After that you move to Free and you won’t be charged again.</li>
        <li>If you change your mind before that date, you can reactivate it with one click.</li>
      </ul>

      <h2>Changing plans</h2>
      <ul>
        <li><strong>Upgrading:</strong> you’re only charged today for the remaining days of the month, prorated.</li>
        <li><strong>Downgrading:</strong> you pay nothing. Whatever is left over from the pricier plan stays as credit and is deducted from upcoming invoices.</li>
      </ul>

      <h2>When we issue a refund</h2>
      <ul>
        <li>Months already charged aren’t refunded for cancelling or for not having used the plan. That’s why the plan stays active until the month ends.</li>
        <li>We do refund the full amount if we charge you twice or by mistake, or if the service was down for a significant part of the month due to our fault. Write to us at <a href={`mailto:${RESPONSABLE.soporte}`}>{RESPONSABLE.soporte}</a> with the charge’s reference (you can see it in Billing). We review it within five business days at most, and the refund reaches the same card in about 5 to 10 days, depending on your bank.</li>
        <li>If you buy a plan for the first time and change your mind, Colombian law gives you five business days from the first charge to withdraw, as long as you haven’t substantially used the plan.</li>
      </ul>

      <h2>API credits</h2>
      <ul>
        <li>Top-ups are one-time payments. The balance never expires and only goes down when you use the API.</li>
        <li>Unused balance isn’t refunded in cash, unless the charge was a mistake or we shut down the service.</li>
        <li>If you delete your account, any remaining balance is lost. Spend it first.</li>
      </ul>

      <h2>Failed charges and disputes</h2>
      <p>
        If your bank declines a renewal, we send you an email with a link to
        pay or change your card, and the plan stays active while Stripe
        retries it. Before opening a dispute with your bank, write to us: we
        can fix a mistaken charge faster than a chargeback can.
      </p>

      <p>In effect since {VIGENCIA}.</p>
    </>
  );
}

const CUERPOS = { privacy: Privacidad, terms: Terminos, refunds: Reembolsos };

export { CUERPOS };
